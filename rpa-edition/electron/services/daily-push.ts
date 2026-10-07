import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ContentItem, DailyPushSettings, DailyPushState, DailyPushView, WeatherForecast } from '../../src/domain/business';

// 每日群推送：每天固定时刻生成“天气 + 今日推荐”，通过 RPA 逐个发到选中的群。

/** 错过发送时刻后，多长时间内启动程序仍会补发；超过则当天跳过，避免深夜打扰客户。 */
export const CATCH_UP_MS = 3 * 60 * 60 * 1000;
/** 发送失败后的重试间隔与当天最多尝试次数（只重试失败的群）。 */
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS_PER_DAY = 3;
/** 单条文本上限，和企业微信群发保持一致（4000 字节），留出余量。 */
export const MAX_CONTENT_BYTES = 3800;

export const defaultDailyPushSettings: DailyPushSettings = {
  enabled: false, sendTime: '17:50', includeWeather: true, location: '', includeRecommendation: true,
  footer: '', targets: [], launchAtLogin: false,
};
const defaultState: DailyPushState = { doneTargets: [], attempts: 0 };

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
  /** 通过 RPA 逐个群发送，返回发送失败的群和原因。 */
  send(input: { chatIds: string[]; content: string; action: string }): Promise<{ failed: Record<string, string> }>;
  /** 群管理里当前的群名，用于提示。 */
  groupName(chatId: string): string | undefined;
};

export type DailyPushRunResult = { ok: boolean; content?: string; sent: number; errors: string[]; message: string };

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
  /** 当天第一次尝试生成的内容，重试时沿用，保证各群收到相同内容。 */
  private pendingContent: { date: string; content: string; recommendationId?: string } | null = null;

  constructor(private readonly store: DailyPushStore, private readonly deps: DailyPushDeps) {}

  async tick(now = new Date()): Promise<DailyPushRunResult | null> {
    if (!isDue(now, this.store.settings(), this.store.state())) return null;
    return this.run(now);
  }

  /** 预览当天将要发送的内容，不发送、不推进推荐轮换。 */
  async preview(settings: DailyPushSettings = this.store.settings()): Promise<{ ok: boolean; content?: string; stderr?: string }> {
    try { return { ok: true, content: (await this.buildContent({ ...defaultDailyPushSettings, ...settings }, this.store.state())).content }; }
    catch (error: any) { return { ok: false, stderr: error?.message || '内容生成失败' }; }
  }

  /** 立即执行当天的推送（手动触发也算当天这一次：每个群每天最多一条）。 */
  async run(now = new Date()): Promise<DailyPushRunResult> {
    if (this.running) return { ok: false, sent: 0, errors: [], message: '上一次推送仍在进行中' };
    this.running = true;
    try { return await this.runOnce(now); } finally { this.running = false; }
  }

  private async runOnce(now: Date): Promise<DailyPushRunResult> {
    const settings = this.store.settings();
    const today = localDate(now);
    let state = this.store.state();
    if (state.lastRunDate === today) return { ok: false, sent: 0, errors: [], message: '今天已经推送过，每个群每天最多推送一条' };
    if (state.attemptDate !== today) state = { ...state, attemptDate: today, attempts: 0, doneTargets: [] };
    state = { ...state, attempts: state.attempts + 1, lastAttemptAt: now.toISOString() };
    this.store.saveState(state);

    const finish = (result: DailyPushRunResult) => { this.store.saveState({ ...state, lastResult: `${now.toLocaleString()}：${result.message}` }); return result; };
    const chatIds = [...new Set(settings.targets.map(target => target.chatId))].filter(chatId => !state.doneTargets.includes(chatId));
    if (!chatIds.length) return finish({ ok: false, sent: 0, errors: [], message: '没有可推送的群，请先选择目标群' });

    let built: { content: string; recommendationId?: string };
    try {
      built = this.pendingContent?.date === today ? this.pendingContent : await this.buildContent(settings, state);
    } catch (error: any) {
      return finish({ ok: false, sent: 0, errors: [error?.message || '内容生成失败'], message: `内容生成失败：${error?.message || '未知错误'}` });
    }
    this.pendingContent = { date: today, ...built };

    const errors: string[] = [];
    let failed: Record<string, string> = {};
    try { failed = (await this.deps.send({ chatIds, content: built.content, action: '每日推送' })).failed; }
    catch (error: any) { failed = Object.fromEntries(chatIds.map(chatId => [chatId, error?.message || '发送失败'])); }
    const done = chatIds.filter(chatId => !failed[chatId]);
    for (const [chatId, reason] of Object.entries(failed)) errors.push(`${this.deps.groupName(chatId) ?? settings.targets.find(target => target.chatId === chatId)?.name ?? '已删除的群'}：${reason}`);
    state = { ...state, doneTargets: [...state.doneTargets, ...done] };

    if (done.length) state = { ...state, lastRecommendationId: built.recommendationId ?? state.lastRecommendationId };
    const allDone = errors.length === 0;
    if (allDone) { state = { ...state, lastRunDate: today }; this.pendingContent = null; }
    const summary = done.length ? `已通过 RPA 发送到 ${done.length} 个群` : '没有发送成功的群';
    const retry = allDone ? '' : state.attempts < MAX_ATTEMPTS_PER_DAY ? `；失败的群将在 ${RETRY_INTERVAL_MS / 60000} 分钟后重试` : '；今天已达到重试上限';
    return finish({ ok: allDone, content: built.content, sent: done.length, errors, message: `${summary}${errors.length ? `；失败：${errors.join('；')}` : ''}${retry}` });
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
