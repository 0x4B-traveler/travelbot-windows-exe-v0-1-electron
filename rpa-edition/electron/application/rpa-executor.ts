import { RPA_CLIENT_LABELS, SELF_CHAT_NAME, type AccountStatus, type LogEntry, type RpaGuard, type RpaSettings } from '../../src/domain/ops';
import type { DesktopRpaGateway } from './ports';

// RPA 执行器：一个账号（一台电脑上登录的企业微信 / 微信）一个执行器。
// 防封规则（时段、限频、群间隔、熔断）都按账号计算：主控用它发本机账号，执行端用它执行主控发来的指令。

/** 防封规则拦下的发送：不算 RPA 故障，不触发熔断。 */
export class GuardBlocked extends Error {}
/** 客户端弹出了安全验证（设备环境异常、要求扫码）：暂停这个账号的全部发送，直到人工验证后“检测本机客户端”通过。 */
export class ClientLocked extends Error {}

export type RpaSendContext = { taskId?: string; attempt?: number; action?: string; /** 运营任务连发多个群时为 true，群与群之间随机间隔。 */ paced?: boolean };
export type RpaSendResult = { sent: boolean; images: number; detail: string };

type Logger = { write(entry: Omit<LogEntry, 'id' | 'time'>): void; rpaSentSince(account: string, since: Date, groupName?: string): number };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);
const fmt = (date: Date) => date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function startOfLocalDay(date: Date) { const day = new Date(date); day.setHours(0, 0, 0, 0); return day; }

function minutesOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 不在发送时段时返回下一个时段开始的时间，在时段内返回 null。支持跨零点（如 22:00–02:00）。 */
export function nextActiveStart(guard: Pick<RpaGuard, 'activeStart' | 'activeEnd'>, now: Date): Date | null {
  const start = minutesOf(guard.activeStart); const end = minutesOf(guard.activeEnd);
  if (start === null || end === null || start === end) return null;
  const current = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (inside) return null;
  const next = new Date(now); next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/** 开头随机加一句问候，让不同群收到的文字略有不同。 */
export function varyOpening(text: string, now: Date): string {
  const hour = now.getHours();
  const word = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const forms = [`${word}～`, `大家${word}！`, `各位${word}`, `${word}呀`, `亲们${word}～`, `Hi 各位，${word}`];
  return `${forms[Math.floor(Math.random() * forms.length)]}\n${text}`;
}

export class RpaExecutor {
  private failures = 0;
  private pausedUntil = 0;
  private lastSentAt = 0;
  /** 客户端弹出安全验证后的暂停原因，检测客户端通过才清除。 */
  private lockedReason = '';
  /** 同一个账号一次只操作一个群，间隔等待也在队列里，多个任务同时到点时依次执行。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly accountId: string,
    private readonly rpa: DesktopRpaGateway,
    private readonly settings: () => RpaSettings,
    private readonly logs: Logger,
    /** 客户端弹出安全验证时通知人（系统通知），需要尽快扫码。 */
    private readonly onLocked: (reason: string) => void = () => undefined,
  ) {}

  /** 防封规则检查：返回拦截原因，可以发时返回 null。 */
  blockReason(groupName: string | undefined, now: Date): string | null {
    const guard = this.settings().guard;
    if (this.lockedReason) return `客户端弹出了安全验证，已暂停全部发送。请扫码验证后到“设置”点“检测本机客户端”恢复`;
    if (this.pausedUntil > now.getTime()) return `RPA 连续失败后暂停中，${fmt(new Date(this.pausedUntil))} 后恢复`;
    if (nextActiveStart(guard, now)) return `不在发送时段（${guard.activeStart}–${guard.activeEnd}）`;
    if (guard.maxPerHour > 0 && this.logs.rpaSentSince(this.accountId, new Date(now.getTime() - 3600 * 1000)) >= guard.maxPerHour) return `最近一小时已发 ${guard.maxPerHour} 次，达到上限`;
    const today = startOfLocalDay(now);
    if (guard.maxPerDay > 0 && this.logs.rpaSentSince(this.accountId, today) >= guard.maxPerDay) return `今天已发 ${guard.maxPerDay} 次，达到每日上限`;
    if (groupName && groupName !== SELF_CHAT_NAME && guard.maxPerGroupPerDay > 0 && this.logs.rpaSentSince(this.accountId, today, groupName) >= guard.maxPerGroupPerDay) return `这个群今天已发 ${guard.maxPerGroupPerDay} 次，达到单群上限`;
    return null;
  }

  /** 熔断暂停中返回恢复时间。 */
  pausedTill(now: Date): Date | null { return this.pausedUntil > now.getTime() ? new Date(this.pausedUntil) : null; }

  /** 检查客户端窗口和防封规则，不发送。 */
  async check(groupName?: string, override?: RpaSettings): Promise<AccountStatus> {
    const settings = override ?? this.settings();
    const now = new Date();
    const client = RPA_CLIENT_LABELS[settings.client];
    const sentToday = this.logs.rpaSentSince(this.accountId, startOfLocalDay(now));
    const paused = this.pausedTill(now);
    try {
      const detail = await this.rpa.check(settings);
      // 检测通过说明安全验证已经处理好了，恢复发送
      if (this.lockedReason) {
        this.lockedReason = '';
        this.logs.write({ module: 'RPA', action: '恢复发送', status: 'info', account: this.accountId, message: '客户端检测正常，没有安全验证弹窗，已恢复发送' });
      }
      const blocked = this.blockReason(groupName, now);
      return { ok: !blocked, detail: blocked ? `防封规则：${blocked}` : detail, client, sentToday, pausedUntil: paused?.toISOString() };
    } catch (error: any) {
      if (error instanceof ClientLocked) this.lock(error.message);
      return { ok: false, detail: error?.message || String(error), client, sentToday, pausedUntil: paused?.toISOString() };
    }
  }

  private lock(reason: string) {
    const first = !this.lockedReason;
    this.lockedReason = reason;
    if (!first) return;
    this.logs.write({ module: 'RPA', action: '安全验证暂停', status: 'fail', account: this.accountId, message: reason });
    this.onLocked(reason);
  }

  send(groupName: string, text: string, images: string[], context: RpaSendContext): Promise<RpaSendResult> {
    const next = this.queue.then(() => this.sendNow(groupName, text, images, context));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async sendNow(groupName: string, text: string, images: string[], context: RpaSendContext): Promise<RpaSendResult> {
    const settings = this.settings(); const guard = settings.guard;
    const label = RPA_CLIENT_LABELS[settings.client];
    const base = { module: 'RPA' as const, taskId: context.taskId, groupName, attempt: context.attempt, account: this.accountId, action: context.action ?? '发送' };
    const blocked = this.blockReason(groupName, new Date());
    if (blocked) {
      this.logs.write({ ...base, status: 'fail', message: `防封规则：${blocked}，本次未发送` });
      throw new GuardBlocked(`防封规则：${blocked}，本次未发送`);
    }
    // 连发多个群时，群与群之间随机停一会儿，像人一样一个个发
    if (context.paced && this.lastSentAt) {
      const gapMs = randomBetween(guard.groupGapMinSec, Math.max(guard.groupGapMinSec, guard.groupGapMaxSec)) * 1000;
      const wait = this.lastSentAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const attachments = images.slice(0, Math.max(0, guard.maxImages));
    try {
      const { sent, locked } = await this.rpa.sendText(groupName, guard.varyOpening ? varyOpening(text, new Date()) : text, attachments);
      this.failures = 0;
      const what = attachments.length ? `文字和 ${attachments.length} 张图` : '文字';
      const detail = sent ? `已通过${label}发送${what}` : `已把${what}粘贴到${label}输入框，等待人工按发送`;
      this.logs.write({ ...base, status: 'ok', message: locked ? `${detail}（发送后弹出了安全验证，图片可能没发全）` : detail });
      if (locked) this.lock(locked);
      return { sent, images: attachments.length, detail };
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logs.write({ ...base, status: 'fail', message });
      // 安全验证不算普通失败：直接暂停，不走熔断计数
      if (error instanceof ClientLocked) { this.lock(message); throw new GuardBlocked(message); }
      this.failures += 1;
      if (guard.pauseAfterFailures > 0 && this.failures >= guard.pauseAfterFailures) {
        this.pausedUntil = Date.now() + Math.max(1, guard.pauseMinutes) * 60 * 1000;
        this.failures = 0;
        this.logs.write({ module: 'RPA', action: '熔断暂停', status: 'fail', taskId: context.taskId, account: this.accountId, message: `连续失败 ${guard.pauseAfterFailures} 次，RPA 暂停到 ${fmt(new Date(this.pausedUntil))}，请检查客户端是否掉线或弹出了验证` });
      }
      throw error;
    } finally {
      this.lastSentAt = Date.now();
    }
  }
}
