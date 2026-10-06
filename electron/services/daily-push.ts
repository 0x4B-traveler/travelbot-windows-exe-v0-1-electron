import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContentItem, DailyPushSettings, DailyPushState, DailyPushTarget, DailyPushView, GroupMessageRecord, WeatherForecast } from '../../src/domain/business';

// 每日客户群推送：每天固定时刻生成“天气 + 今日推荐”，按群主各创建一个客户群群发任务，
// 群主在企业微信里点一次“发送”即可发到他名下选中的全部客户群。

/** 错过发送时刻后，多长时间内启动程序仍会补发；超过则当天跳过，避免深夜打扰客户。 */
export const CATCH_UP_MS = 3 * 60 * 60 * 1000;
/** 创建任务失败后的重试间隔与当天最多尝试次数。 */
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS_PER_DAY = 3;
/** 企业微信群发文本上限 4000 字节，留出余量。 */
export const MAX_CONTENT_BYTES = 3800;

export const defaultDailyPushSettings: DailyPushSettings = {
  enabled: false, sendTime: '17:50', includeWeather: true, location: '', includeRecommendation: true,
  footer: '', ownerUserIds: [], targets: [], launchAtLogin: false,
};
const defaultState: DailyPushState = { doneOwners: [], attempts: 0 };

export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseSendTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

function scheduledAt(day: Date, sendTime: string): Date | null {
  const time = parseSendTime(sendTime);
  if (!time) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

/** 下午及以后发送时播报明天的天气，上午发送播报今天。 */
export function forecastDay(sendTime: string): { offset: 0 | 1; label: string } {
  return (parseSendTime(sendTime)?.hour ?? 0) >= 12 ? { offset: 1, label: '明日' } : { offset: 0, label: '今日' };
}

export function isDue(now: Date, settings: DailyPushSettings, state: DailyPushState): boolean {
  if (!settings.enabled || !settings.targets.length) return false;
  const at = scheduledAt(now, settings.sendTime);
  if (!at || now < at || now.getTime() - at.getTime() > CATCH_UP_MS) return false;
  const today = localDate(now);
  if (state.lastRunDate === today) return false;
  if (state.attemptDate !== today) return true;
  if (state.attempts >= MAX_ATTEMPTS_PER_DAY) return false;
  return !state.lastAttemptAt || now.getTime() - new Date(state.lastAttemptAt).getTime() >= RETRY_INTERVAL_MS;
}

export function nextRunAt(now: Date, settings: DailyPushSettings, state: DailyPushState): Date | null {
  if (!settings.enabled || !settings.targets.length) return null;
  const today = scheduledAt(now, settings.sendTime);
  if (!today) return null;
  if (state.lastRunDate !== localDate(now) && now <= today) return today;
  if (isDue(now, settings, state)) return now;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return scheduledAt(tomorrow, settings.sendTime);
}

/** 按创建顺序轮换：取上次推荐的下一条，到末尾后从头开始。 */
export function pickRecommendation(items: ContentItem[], lastId?: string): ContentItem | null {
  if (!items.length) return null;
  const index = lastId ? items.findIndex(item => item.id === lastId) : -1;
  return items[(index + 1) % items.length];
}

export function groupTargetsByOwner(targets: DailyPushTarget[], skipOwners: string[] = []): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const target of targets) {
    if (!target.owner || skipOwners.includes(target.owner)) continue;
    byOwner.set(target.owner, [...(byOwner.get(target.owner) ?? []), target.chatId]);
  }
  return byOwner;
}

function byteLength(text: string) { return Buffer.byteLength(text, 'utf8'); }

export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let result = '';
  for (const char of text) { if (byteLength(result + char + '…') > maxBytes) break; result += char; }
  return `${result}…`;
}

export function composeMessage(parts: { weather?: string; recommendation?: ContentItem | null; footer?: string }): string {
  const head = parts.weather?.trim() ?? '';
  const footer = parts.footer?.trim() ?? '';
  let body = '';
  if (parts.recommendation) {
    const title = `【今日推荐】${parts.recommendation.title}`;
    const fixed = [head, title, footer].filter(Boolean).join('\n\n');
    body = truncateToBytes(parts.recommendation.body.trim(), Math.max(0, MAX_CONTENT_BYTES - byteLength(fixed) - 4));
    body = body ? `${title}\n${body}` : title;
  }
  return truncateToBytes([head, body, footer].filter(Boolean).join('\n\n'), MAX_CONTENT_BYTES);
}

export type DailyPushDeps = {
  getForecast(location: string, offset: 0 | 1): Promise<WeatherForecast>;
  formatForecast(forecast: WeatherForecast, label: string): string;
  listRecommendations(): ContentItem[];
  createGroupMessage(input: { sender: string; chatIds: string[]; content: string }): Promise<{ msgid: string; failList: string[] }>;
  addHistory(record: GroupMessageRecord): void;
};

export type DailyPushRunResult = { ok: boolean; content?: string; created: Array<{ owner: string; msgid: string; groups: number }>; errors: string[]; message: string };

export class DailyPushStore {
  private readonly settingsPath: string;
  private readonly statePath: string;

  constructor(userDataDir: string) {
    this.settingsPath = join(userDataDir, 'travelbot-daily-push.json');
    this.statePath = join(userDataDir, 'travelbot-daily-push-state.json');
  }

  settings(): DailyPushSettings { return { ...defaultDailyPushSettings, ...readJson<Partial<DailyPushSettings>>(this.settingsPath, {}) }; }
  saveSettings(settings: DailyPushSettings) { writeJson(this.settingsPath, settings); }
  state(): DailyPushState { return { ...defaultState, ...readJson<Partial<DailyPushState>>(this.statePath, {}) }; }
  saveState(state: DailyPushState) { writeJson(this.statePath, state); }

  view(now = new Date()): DailyPushView {
    const settings = this.settings(); const state = this.state();
    return { ...settings, state, nextRunAt: nextRunAt(now, settings, state)?.toISOString() };
  }
}

export class DailyPushRunner {
  private running = false;
  /** 当天第一次尝试生成的内容，重试时沿用，保证各群主收到相同内容。 */
  private pendingContent: { date: string; content: string; recommendationId?: string } | null = null;

  constructor(private readonly store: DailyPushStore, private readonly deps: DailyPushDeps) {}

  async tick(now = new Date()): Promise<DailyPushRunResult | null> {
    if (!isDue(now, this.store.settings(), this.store.state())) return null;
    return this.run(now);
  }

  /** 预览当天将要发送的内容，不创建任务、不推进推荐轮换。 */
  async preview(settings: DailyPushSettings = this.store.settings()): Promise<{ ok: boolean; content?: string; stderr?: string }> {
    try { return { ok: true, content: (await this.buildContent({ ...defaultDailyPushSettings, ...settings }, this.store.state())).content }; }
    catch (error: any) { return { ok: false, stderr: error?.message || '内容生成失败' }; }
  }

  /** 立即执行当天的推送（手动触发也计入当天额度：每个客户群每天最多一条）。 */
  async run(now = new Date()): Promise<DailyPushRunResult> {
    if (this.running) return { ok: false, created: [], errors: [], message: '上一次推送仍在进行中' };
    this.running = true;
    try { return await this.runOnce(now); } finally { this.running = false; }
  }

  private async runOnce(now: Date): Promise<DailyPushRunResult> {
    const settings = this.store.settings();
    const today = localDate(now);
    let state = this.store.state();
    if (state.lastRunDate === today) return { ok: false, created: [], errors: [], message: '今天已经创建过群发任务，每个客户群每天最多推送一条' };
    if (state.attemptDate !== today) state = { ...state, attemptDate: today, attempts: 0, doneOwners: [] };
    state = { ...state, attempts: state.attempts + 1, lastAttemptAt: now.toISOString() };
    this.store.saveState(state);

    const finish = (result: DailyPushRunResult) => { this.store.saveState({ ...state, lastResult: `${now.toLocaleString()}：${result.message}` }); return result; };
    const byOwner = groupTargetsByOwner(settings.targets, state.doneOwners);
    if (!byOwner.size) return finish({ ok: false, created: [], errors: [], message: '没有可推送的客户群，请先选择目标客户群' });

    let built: { content: string; recommendationId?: string };
    try {
      built = this.pendingContent?.date === today ? this.pendingContent : await this.buildContent(settings, state);
    } catch (error: any) {
      return finish({ ok: false, created: [], errors: [error?.message || '内容生成失败'], message: `内容生成失败：${error?.message || '未知错误'}` });
    }
    this.pendingContent = { date: today, ...built };

    const created: DailyPushRunResult['created'] = [];
    const errors: string[] = [];
    for (const [owner, chatIds] of byOwner) {
      try {
        const { msgid, failList } = await this.deps.createGroupMessage({ sender: owner, chatIds, content: built.content });
        this.deps.addHistory({ msgid, createdAt: now.toISOString(), sender: owner, chatIds, content: built.content, source: 'schedule' });
        created.push({ owner, msgid, groups: chatIds.length - failList.length });
        state = { ...state, doneOwners: [...state.doneOwners, owner] };
        this.store.saveState(state);
      } catch (error: any) {
        errors.push(`${owner}：${error?.message || '创建群发任务失败'}`);
      }
    }

    if (created.length) state = { ...state, lastRecommendationId: built.recommendationId ?? state.lastRecommendationId };
    const allDone = errors.length === 0;
    if (allDone) { state = { ...state, lastRunDate: today }; this.pendingContent = null; }
    const summary = created.length ? `已为 ${created.length} 位群主创建群发任务，等待群主在企业微信中确认发送` : '未能创建群发任务';
    const retry = allDone ? '' : state.attempts < MAX_ATTEMPTS_PER_DAY ? `；失败的群主将在 ${RETRY_INTERVAL_MS / 60000} 分钟后重试` : '；今天已达到重试上限';
    return finish({ ok: allDone, content: built.content, created, errors, message: `${summary}${errors.length ? `；失败：${errors.join('；')}` : ''}${retry}` });
  }

  private async buildContent(settings: DailyPushSettings, state: DailyPushState): Promise<{ content: string; recommendationId?: string }> {
    let weather = '';
    let weatherError = '';
    if (settings.includeWeather && settings.location.trim()) {
      const day = forecastDay(settings.sendTime);
      try { weather = this.deps.formatForecast(await this.deps.getForecast(settings.location, day.offset), day.label); }
      catch (error: any) { weatherError = error?.message || '天气获取失败'; }
    }
    const recommendation = settings.includeRecommendation ? pickRecommendation(this.deps.listRecommendations(), state.lastRecommendationId) : null;
    // 天气失败但有推荐时照常发送推荐；两者都没有则不发，避免只发一句落款。
    if (!weather && !recommendation) throw new Error(weatherError || (settings.includeRecommendation ? '内容库为空，且未配置天气' : '未配置天气位置'));
    return { content: composeMessage({ weather, recommendation, footer: settings.footer }), recommendationId: recommendation?.id };
  }
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}
