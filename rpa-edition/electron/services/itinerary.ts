import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CustomerGroup, ItineraryItem, ItineraryJobKind, ItineraryJobRecord, ItineraryJobView,
  ItineraryParseResult, ItineraryQuota, ItinerarySettings, ItineraryView, WeatherForecast,
} from '../../src/domain/business';
import { localDate, MAX_CONTENT_BYTES, parseSendTime, truncateToBytes } from './daily-push';

// 行程定时群发：按录入的旅游团行程，为每个客户群生成“前一晚的每日行程”和可选的“节点单独提醒”，
// 到点通过 RPA 在桌面客户端里直接发到群里。群名对应“群管理”里添加的群。

/** 发送失败后的重试间隔与每个任务最多尝试次数。 */
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
/** 当天没有带时间的行程时，每日行程最晚在当天中午前创建。 */
const DIGEST_FALLBACK_DEADLINE = '12:00';

export const defaultItinerarySettings: ItinerarySettings = {
  enabled: false, dryRun: true, digestTime: '20:00', reminderLeadMinutes: 30, includeWeather: true,
  footer: '',
};

// ---------- 解析 ----------

type Column = 'groupName' | 'date' | 'time' | 'place' | 'activity' | 'city' | 'separate';
/** 未识别到表头时的默认列顺序，与界面提示一致。 */
export const DEFAULT_COLUMNS: Column[] = ['groupName', 'date', 'time', 'place', 'activity', 'city', 'separate'];
const HEADER_PATTERNS: Array<[Column, RegExp]> = [
  ['separate', /单独|提醒/], ['city', /城市/], ['date', /日期/], ['time', /时间|时刻/],
  ['groupName', /群名|客户群|群聊|团名|^群$/], ['place', /地点|地址|景点/], ['activity', /事项|内容|行程|安排|活动/],
];

function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map(cell => cell.trim());
  if (/[,，]/.test(line)) return line.split(/[,，]/).map(cell => cell.trim());
  return line.trim().split(/\s+/);
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return localDate(date);
}

/** 支持 2026-10-08、2026/10/8、2026年10月8日、10/8、10月8日；省略年份时取今天之后最近的那个日期（允许 60 天内的过去日期）。 */
export function parseDate(value: string, now = new Date()): string | null {
  const text = value.trim().replace(/\s+/g, '').replace(/[（(].*[)）]$/, '');
  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (full) return validDate(Number(full[1]), Number(full[2]), Number(full[3]));
  const short = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (!short) return null;
  const month = Number(short[1]); const day = Number(short[2]);
  const thisYear = validDate(now.getFullYear(), month, day);
  if (!thisYear) return validDate(now.getFullYear() + 1, month, day);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60);
  return new Date(now.getFullYear(), month - 1, day) < cutoff ? validDate(now.getFullYear() + 1, month, day) : thisYear;
}

/** 支持 8:00、08:00、8:00:00、8点、8点半、下午2点；空白或“全天”返回空字符串；无法识别返回 null。 */
export function parseTime(value: string): string | null {
  const text = value.trim().replace(/\s+/g, '');
  if (!text || /^全天$/.test(text)) return '';
  const match = /^(上午|早上|中午|下午|晚上)?(\d{1,2})(?:[:：](\d{1,2})(?::\d{1,2})?|[点时](半|(\d{1,2})分?)?)?/.exec(text);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = match[3] !== undefined ? Number(match[3]) : match[4] === '半' ? 30 : match[5] !== undefined ? Number(match[5]) : 0;
  if ((match[1] === '下午' || match[1] === '晚上') && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseSeparate(value: string | undefined): boolean {
  return /^(是|y|yes|1|√|✓|✔|true|单独|提醒)$/i.test((value ?? '').trim());
}

function headerColumns(cells: string[]): Column[] | null {
  const columns: Column[] = [];
  let matched = 0;
  for (const cell of cells) {
    const column = HEADER_PATTERNS.find(([key, pattern]) => pattern.test(cell) && !columns.includes(key))?.[0];
    columns.push(column ?? ('' as Column));
    if (column) matched += 1;
  }
  return matched >= 2 && columns.includes('groupName') && columns.includes('date') ? columns : null;
}

/** 解析从 Excel 复制或手动输入的行程表。首行是表头时按表头识别列，否则按默认列顺序。 */
export function parseItinerary(text: string, now = new Date()): ItineraryParseResult {
  const lines = text.split(/\r?\n/).map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
  if (!lines.length) return { items: [], errors: ['没有可导入的行程'] };
  const header = headerColumns(splitLine(lines[0].line));
  const columns = header ?? DEFAULT_COLUMNS;
  const items: ItineraryItem[] = [];
  const errors: string[] = [];
  for (const { line, index } of header ? lines.slice(1) : lines) {
    const cells = splitLine(line);
    const cell = (column: Column) => { const at = columns.indexOf(column); return at >= 0 ? (cells[at] ?? '').trim() : ''; };
    const row = `第 ${index + 1} 行`;
    const groupName = normalizeName(cell('groupName'));
    const date = parseDate(cell('date'), now);
    const time = parseTime(cell('time'));
    const place = cell('place');
    const activity = cell('activity');
    if (!groupName) { errors.push(`${row}：缺少群名`); continue; }
    if (!date) { errors.push(`${row}：日期“${cell('date')}”无法识别，请写成 2026-10-08 或 10月8日`); continue; }
    if (time === null) { errors.push(`${row}：时间“${cell('time')}”无法识别，请写成 08:30`); continue; }
    if (!place && !activity) { errors.push(`${row}：地点和事项至少填一项`); continue; }
    items.push({ id: randomUUID(), groupName, date, time, place, activity, city: cell('city'), separate: parseSeparate(cell('separate')) });
  }
  return { items, errors };
}

// ---------- 群名匹配 ----------

export function normalizeName(name: string): string { return name.trim().replace(/\s+/g, ' '); }

export function matchGroup(groupName: string, groups: CustomerGroup[]): { group?: CustomerGroup; error?: string } {
  const matches = groups.filter(group => normalizeName(group.name) === normalizeName(groupName));
  if (!matches.length) return { error: `群管理里没有“${groupName}”，请先在群管理添加这个群（群名要和客户端里一致）` };
  if (matches.length > 1) return { error: `有 ${matches.length} 个群都叫“${groupName}”，请在客户端里改成不同的群名` };
  return { group: matches[0] };
}

// ---------- 任务规划 ----------

export type PlannedJob = { id: string; kind: ItineraryJobKind; groupName: string; date: string; dueAt: Date; expiresAt: Date; items: ItineraryItem[] };

export function atLocal(date: string, time: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const parsed = parseSendTime(time) ?? { hour: 0, minute: 0 };
  return new Date(year, month - 1, day, parsed.hour, parsed.minute, 0, 0);
}

function compareItems(a: ItineraryItem, b: ItineraryItem) {
  return a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99');
}

/**
 * 每个客户群、每个出行日期生成一条“每日行程”，在前一天 digestTime 创建；
 * 勾选“单独发送”且有时间的节点，再在节点前 reminderLeadMinutes 分钟单独创建一条提醒。
 */
export function planJobs(items: ItineraryItem[], settings: ItinerarySettings): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  const byGroupDate = new Map<string, ItineraryItem[]>();
  for (const item of [...items].sort(compareItems)) {
    const key = `${normalizeName(item.groupName)}|${item.date}`;
    byGroupDate.set(key, [...(byGroupDate.get(key) ?? []), item]);
  }
  for (const [key, dayItems] of byGroupDate) {
    const [groupName, date] = key.split('|');
    const dayStart = atLocal(date, '00:00');
    const dueAt = atLocal(localDate(new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - 1)), settings.digestTime);
    const firstTimed = dayItems.find(item => item.time);
    const expiresAt = atLocal(date, firstTimed?.time || DIGEST_FALLBACK_DEADLINE);
    jobs.push({ id: `digest|${groupName}|${date}`, kind: 'digest', groupName, date, dueAt, expiresAt: expiresAt > dueAt ? expiresAt : dueAt, items: dayItems });
  }
  for (const item of items) {
    if (!item.separate || !item.time) continue;
    const at = atLocal(item.date, item.time);
    jobs.push({ id: `reminder|${item.id}`, kind: 'reminder', groupName: normalizeName(item.groupName), date: item.date, dueAt: new Date(at.getTime() - Math.max(0, settings.reminderLeadMinutes) * 60000), expiresAt: at, items: [item] });
  }
  return jobs.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
}

// ---------- 内容 ----------

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 相对“创建任务那一刻”的日期称呼：今日 / 明日 / 10月8日。 */
export function dayLabel(date: string, now: Date): string {
  if (date === localDate(now)) return '今日';
  if (date === localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return '明日';
  const day = atLocal(date, '00:00');
  return `${day.getMonth() + 1}月${day.getDate()}日`;
}

function dateTitle(date: string): string {
  const day = atLocal(date, '00:00');
  return `${day.getMonth() + 1}月${day.getDate()}日 周${WEEKDAYS[day.getDay()]}`;
}

function itemLine(item: ItineraryItem): string {
  const what = [item.activity, item.place].filter(Boolean).join(' · ');
  return `${item.time || '全天'} ${what}`;
}

export function composeDigest(job: PlannedJob, label: string, weather: string[], footer: string): string {
  const prefix = label === '今日' || label === '明日' ? label : '';
  const parts = [`【${prefix}行程 · ${dateTitle(job.date)}】\n${job.items.map(itemLine).join('\n')}`, weather.join('\n'), footer.trim()];
  return truncateToBytes(parts.filter(Boolean).join('\n\n'), MAX_CONTENT_BYTES);
}

export function composeReminder(item: ItineraryItem, label: string, weather: string[], footer: string): string {
  const head = `【行程提醒】${label} ${item.time} ${item.activity || item.place}`;
  const place = item.place && item.activity ? `地点：${item.place}` : '';
  return truncateToBytes([[head, place].filter(Boolean).join('\n'), weather.join('\n'), footer.trim()].filter(Boolean).join('\n\n'), MAX_CONTENT_BYTES);
}

/** 需要查询天气的城市：优先用“城市”列，否则用地点；去重后保持行程顺序。 */
export function weatherLocations(items: ItineraryItem[]): string[] {
  return [...new Set(items.map(item => (item.city || item.place).trim()).filter(Boolean))];
}

// ---------- 状态与视图 ----------

export type ItineraryState = { jobs: Record<string, ItineraryJobRecord>; lastResult?: string };

/** 关闭干跑后，之前的干跑记录不再算作已处理，到点会真正创建任务。 */
export function activeRecord(record: ItineraryJobRecord | undefined, settings: ItinerarySettings): ItineraryJobRecord | undefined {
  if (record?.status === 'dry-run' && !settings.dryRun) return undefined;
  return record;
}

export function canAttempt(record: ItineraryJobRecord | undefined, now: Date): boolean {
  if (!record) return true;
  if (record.status !== 'failed') return false;
  if (record.attempts >= MAX_ATTEMPTS) return false;
  return !record.lastAttemptAt || now.getTime() - new Date(record.lastAttemptAt).getTime() >= RETRY_INTERVAL_MS;
}

export function isJobDue(job: PlannedJob, record: ItineraryJobRecord | undefined, now: Date): boolean {
  return now >= job.dueAt && now < job.expiresAt && canAttempt(record, now);
}

export function buildView(settings: ItinerarySettings, items: ItineraryItem[], state: ItineraryState, groups: CustomerGroup[], now = new Date()): ItineraryView {
  const planned = planJobs(items, settings);
  const jobs: ItineraryJobView[] = planned.map(job => {
    const record = activeRecord(state.jobs[job.id], settings);
    const match = matchGroup(job.groupName, groups);
    let status: ItineraryJobView['status'];
    if (record?.status === 'created') status = 'confirmed';
    else if (record?.status === 'dry-run') status = 'dry-run';
    else if (record?.status === 'failed' && !(canAttempt(record, now) && now < job.expiresAt)) status = 'failed';
    else if (match.error) status = 'unmatched';
    else if (now >= job.expiresAt) status = 'expired';
    else if (now >= job.dueAt) status = record?.status === 'failed' ? 'failed' : 'due';
    else status = 'scheduled';
    const summary = job.kind === 'digest' ? `${job.items.length} 个行程节点` : itemLine(job.items[0]);
    return { id: job.id, kind: job.kind, groupName: job.groupName, date: job.date, dueAt: job.dueAt.toISOString(), expiresAt: job.expiresAt.toISOString(), summary, status, matchError: match.error, record };
  });

  // RPA 直接发送，没有企业微信群发的月度额度；频率由防封设置（单群每天上限等）控制
  const quota: ItineraryQuota[] = [];
  const warnings: string[] = [];
  const unmatched = [...new Set(jobs.filter(job => job.matchError && job.status !== 'expired').map(job => job.matchError as string))];
  warnings.push(...unmatched);
  const untimed = items.filter(item => item.separate && !item.time);
  if (untimed.length) warnings.push(`${untimed.length} 个勾选了“单独发送”的行程没有时间，只会出现在每日行程里`);
  return { settings, items: [...items].sort(compareItems), jobs, quota, warnings, lastResult: state.lastResult };
}

// ---------- 存储 ----------

export class ItineraryStore {
  private readonly dataPath: string;
  private readonly statePath: string;

  constructor(userDataDir: string) {
    this.dataPath = join(userDataDir, 'travelbot-itinerary.json');
    this.statePath = join(userDataDir, 'travelbot-itinerary-state.json');
  }

  private data(): { settings: ItinerarySettings; items: ItineraryItem[] } {
    const raw = readJson<{ settings?: Partial<ItinerarySettings>; items?: ItineraryItem[] }>(this.dataPath, {});
    return { settings: { ...defaultItinerarySettings, ...raw.settings }, items: Array.isArray(raw.items) ? raw.items : [] };
  }

  settings(): ItinerarySettings { return this.data().settings; }
  items(): ItineraryItem[] { return this.data().items; }
  saveSettings(settings: ItinerarySettings) { writeJson(this.dataPath, { ...this.data(), settings }); }
  saveItems(items: ItineraryItem[]) { writeJson(this.dataPath, { ...this.data(), items }); }
  state(): ItineraryState { const raw = readJson<Partial<ItineraryState>>(this.statePath, {}); return { jobs: raw.jobs ?? {}, lastResult: raw.lastResult }; }
  saveState(state: ItineraryState) { writeJson(this.statePath, state); }
  view(groups: CustomerGroup[], now = new Date()): ItineraryView { const data = this.data(); return buildView(data.settings, data.items, this.state(), groups, now); }
}

// ---------- 执行 ----------

export type ItineraryDeps = {
  getForecast(location: string, date: string): Promise<WeatherForecast>;
  formatForecast(forecast: WeatherForecast, label: string): string;
  /** 群管理里的群，按群名匹配行程。 */
  listGroups(): CustomerGroup[];
  /** 通过 RPA 逐个群发送，返回发送失败的群和原因。 */
  send(input: { chatIds: string[]; content: string; action: string }): Promise<{ failed: Record<string, string> }>;
};

export type ItineraryRunResult = { ok: boolean; message: string; created: number; dryRun: number; errors: string[] };

export class ItineraryRunner {
  private running = false;

  constructor(private readonly store: ItineraryStore, private readonly deps: ItineraryDeps) {}

  /** 每分钟调用：发送到点的任务。 */
  async tick(now = new Date()): Promise<ItineraryRunResult | null> {
    if (!this.store.settings().enabled) return null;
    return this.execute(now, (job, record) => isJobDue(job, record, now));
  }

  /** 手动立即发送某个任务（用于测试），不受时间窗口限制，但不会重复发送已成功的任务。 */
  async runJob(jobId: string, now = new Date()): Promise<ItineraryRunResult> {
    return (await this.execute(now, (job, record) => job.id === jobId && (!record || record.status === 'failed'))) ?? { ok: false, message: '找不到该任务，或它已经发送过', created: 0, dryRun: 0, errors: [] };
  }

  private async execute(now: Date, select: (job: PlannedJob, record: ItineraryJobRecord | undefined) => boolean): Promise<ItineraryRunResult | null> {
    if (this.running) return { ok: false, message: '上一次处理仍在进行中', created: 0, dryRun: 0, errors: [] };
    this.running = true;
    try {
      const settings = this.store.settings();
      const groups = this.deps.listGroups();
      const state = this.store.state();
      const jobs = planJobs(this.store.items(), settings).filter(job => select(job, activeRecord(state.jobs[job.id], settings)));
      if (!jobs.length) return null;

      const errors: string[] = [];
      const fail = (job: PlannedJob, error: string) => {
        const previous = state.jobs[job.id];
        state.jobs[job.id] = { status: 'failed', attempts: (previous?.status === 'failed' ? previous.attempts : 0) + 1, lastAttemptAt: now.toISOString(), error };
        errors.push(`${job.groupName}：${error}`);
      };

      // 相同内容的任务合并成一批，逐个群发送
      const buckets = new Map<string, { owner: string; content: string; entries: Array<{ job: PlannedJob; chatId: string }> }>();
      const weatherCache = new Map<string, Promise<string>>();
      for (const job of jobs) {
        const match = matchGroup(job.groupName, groups);
        if (!match.group) { fail(job, match.error ?? '找不到客户群'); continue; }
        const content = await this.buildContent(job, settings, now, weatherCache);
        const key = `${match.group.owner}\n${content}`;
        const bucket = buckets.get(key) ?? { owner: match.group.owner, content, entries: [] };
        bucket.entries.push({ job, chatId: match.group.chatId });
        buckets.set(key, bucket);
      }

      let created = 0; let dryRun = 0;
      for (const bucket of buckets.values()) {
        const base = { owner: bucket.owner, content: bucket.content, lastAttemptAt: now.toISOString(), createdAt: now.toISOString() };
        if (settings.dryRun) {
          for (const { job, chatId } of bucket.entries) state.jobs[job.id] = { ...base, status: 'dry-run', attempts: 1, chatId };
          dryRun += bucket.entries.length;
          continue;
        }
        try {
          const chatIds = [...new Set(bucket.entries.map(entry => entry.chatId))];
          const kind = bucket.entries[0].job.kind === 'digest' ? '每日行程' : '行程提醒';
          const { failed } = await this.deps.send({ chatIds, content: bucket.content, action: kind });
          for (const { job, chatId } of bucket.entries) {
            if (failed[chatId]) { fail(job, failed[chatId]); continue; }
            state.jobs[job.id] = { ...base, status: 'created', attempts: (state.jobs[job.id]?.attempts ?? 0) + 1, chatId, confirmed: true };
            created += 1;
          }
        } catch (error: any) {
          for (const { job } of bucket.entries) fail(job, error?.message || '发送失败');
        }
      }

      const parts = [
        created ? `已通过 RPA 发送 ${created} 条行程消息` : '',
        dryRun ? `干跑生成 ${dryRun} 条行程消息（未真正发送）` : '',
        errors.length ? `失败：${errors.join('；')}` : '',
      ].filter(Boolean);
      const message = parts.join('；') || '没有需要处理的任务';
      state.lastResult = `${now.toLocaleString()}：${message}`;
      this.store.saveState(state);
      return { ok: errors.length === 0, message, created, dryRun, errors };
    } finally {
      this.running = false;
    }
  }

  /** 生成任务内容（不发送），用于预览。 */
  async preview(jobId: string, now = new Date()): Promise<{ ok: boolean; content?: string; stderr?: string }> {
    const settings = this.store.settings();
    const job = planJobs(this.store.items(), settings).find(item => item.id === jobId);
    if (!job) return { ok: false, stderr: '找不到该任务' };
    // 预览按“到点发送时”的视角称呼日期（今日/明日）
    const at = now > job.dueAt ? now : job.dueAt;
    return { ok: true, content: await this.buildContent(job, settings, at, new Map()) };
  }

  private async buildContent(job: PlannedJob, settings: ItinerarySettings, now: Date, cache: Map<string, Promise<string>>): Promise<string> {
    const label = dayLabel(job.date, now);
    const weather: string[] = [];
    if (settings.includeWeather) {
      for (const location of weatherLocations(job.items)) {
        const key = `${location}|${job.date}|${label}`;
        if (!cache.has(key)) cache.set(key, this.deps.getForecast(location, job.date).then(forecast => this.deps.formatForecast(forecast, label)).catch(() => ''));
        const line = await cache.get(key)!;
        // 同一城市可能由不同地点名解析得到，按文字去重
        if (line && !weather.includes(line)) weather.push(line);
      }
    }
    return job.kind === 'digest' ? composeDigest(job, label, weather, settings.footer) : composeReminder(job.items[0], label, weather, settings.footer);
  }
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}
