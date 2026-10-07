import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTENT_CHANNELS, CONTENT_STATUS_LABELS, MATERIAL_KIND_LABELS,
  type ContentChannel, type ContentInput, type ContentPiece, type DryRunGroup, type DryRunReport, type ContentStatus, type ContentVersion, type Dashboard, type DashboardTask,
  type GenerateInput, type GroupMatchMode, type ImportResult, type LogEntry, type LogQuery, type Material, type MaterialFacets,
  type MaterialInput, type MaterialKind, type MaterialQuery, type OpsGroup, type OpsTask, type RefreshResult, type Route, type RouteInput,
  type RouteQuery, type TaskInput, type TaskRepeat, type TaskRun, type TaskStatus,
  DEFAULT_SEND_SETTINGS, MANUAL_CHAT_PREFIX, RPA_CLIENT_LABELS, isManualGroup, type RpaGuard, type RpaSettings, type SendSettings,
} from '../../src/domain/ops';
import { ContentRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TaskRepository, type StoredTask } from '../infrastructure/repositories';
import type { BotGateway, ContentGenerator, CustomerGroupGateway, DesktopRpaGateway, FilePicker, FileStore, SendSettingsStore, WeatherGateway } from './ports';

// Application 层：每个服务只管自己模块的业务规则，跨模块协作通过调用其他服务，不直接碰别人的表或企业微信。

export class OpsError extends Error {}
const fail = (message: string): never => { throw new OpsError(message); };
const nowIso = () => new Date().toISOString();
const fmt = (date: Date) => date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const cleanList = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
function startOfLocalDay(date: Date) { const day = new Date(date); day.setHours(0, 0, 0, 0); return day; }

// ───────── 运行日志 ─────────
export class LogService {
  constructor(private readonly repo: LogRepository) {}
  write(entry: Omit<LogEntry, 'id' | 'time'>) { try { this.repo.add(entry); } catch { /* 日志失败不能影响业务 */ } }
  list(query: LogQuery) { return this.repo.list(query); }
  sentToday(groupName: string) { return this.repo.countSentSince(groupName, startOfLocalDay(new Date()).toISOString()); }
  rpaSentSince(since: Date, groupName?: string) { return this.repo.countRpaSentSince(since.toISOString(), groupName); }
  /** 只保留最近 60 天的日志。 */
  prune() { this.repo.prune(new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()); }
}

// ───────── 素材库 ─────────
const KIND_BY_LABEL = new Map(Object.entries(MATERIAL_KIND_LABELS).map(([kind, label]) => [label, kind as MaterialKind]));

export class MaterialService {
  constructor(private readonly repo: MaterialRepository, private readonly routes: RouteRepository, private readonly files: FileStore, private readonly picker: FilePicker) {}

  list(query: MaterialQuery) { return this.repo.list(query); }
  facets(): MaterialFacets { return this.repo.facets(); }
  getMany(ids: string[]) { return this.repo.getMany(ids); }

  save(input: MaterialInput): Material {
    const fields = { kind: input.kind, title: input.title.trim(), body: input.body.trim(), city: input.city.trim(), tags: cleanList(input.tags) };
    if (!fields.title) fail('请填写素材名称');
    if (!MATERIAL_KIND_LABELS[fields.kind]) fail('素材类型不正确');
    if (input.id) return this.repo.update(input.id, fields) ?? fail('素材不存在或已被删除');
    return this.repo.insert({ ...fields, source: 'manual' });
  }

  delete(id: string) {
    const paths = this.repo.imagePaths(id);
    if (!this.repo.delete(id)) fail('素材不存在或已被删除');
    paths.forEach(path => this.files.remove(path));
    this.routes.unlinkMaterial(id);
  }

  /** 从 Excel 复制的表格（制表符分隔）导入，第一行可以是表头：名称 类型 城市 标签 简介。 */
  import(text: string): ImportResult {
    const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
    if (!lines.length) fail('没有可导入的内容');
    const errors: string[] = []; let added = 0;
    const header = lines[0].split('\t').map(cell => cell.trim());
    const hasHeader = header.includes('名称');
    const index = (name: string, fallback: number) => (hasHeader ? header.indexOf(name) : fallback);
    const columns = { title: index('名称', 0), kind: index('类型', 1), city: index('城市', 2), tags: index('标签', 3), body: index('简介', 4) };
    lines.slice(hasHeader ? 1 : 0).forEach((line, offset) => {
      const cells = line.split('\t').map(cell => cell.trim());
      const cell = (column: number) => (column >= 0 ? cells[column] ?? '' : '');
      const rowNo = offset + (hasHeader ? 2 : 1);
      const title = cell(columns.title);
      if (!title) { errors.push(`第 ${rowNo} 行：缺少名称`); return; }
      const kindText = cell(columns.kind);
      const kind = KIND_BY_LABEL.get(kindText) ?? (kindText ? undefined : 'spot');
      if (!kind) { errors.push(`第 ${rowNo} 行：类型“${kindText}”不认识，可用：${[...KIND_BY_LABEL.keys()].join('、')}`); return; }
      this.repo.insert({ kind, title, city: cell(columns.city), tags: cleanList(cell(columns.tags).split(/[,，、/\s]+/)), body: cell(columns.body), source: 'excel' });
      added += 1;
    });
    return { added, errors };
  }

  async addImages(id: string): Promise<Material> {
    if (!this.repo.get(id)) fail('素材不存在或已被删除');
    for (const path of await this.picker.pickImages()) this.repo.addImage(id, this.files.importFile(path), '');
    return this.repo.get(id)!;
  }

  removeImage(id: string, imageId: string): Material {
    const path = this.repo.removeImage(id, imageId);
    if (path) this.files.remove(path);
    return this.repo.get(id) ?? fail('素材不存在或已被删除');
  }

  /** 图片在本机的保存路径（RPA 发图用）。 */
  imageFile(imageId: string): string | null { return this.repo.imagePath(imageId); }

  imageData(imageId: string) {
    const path = this.repo.imagePath(imageId);
    return path ? this.files.dataUrl(path) : null;
  }
}

// ───────── 路线管理 ─────────
export class RouteService {
  constructor(private readonly repo: RouteRepository, private readonly materials: MaterialRepository) {}

  list(query: RouteQuery) { return this.repo.list(query); }
  get(id: string) { return this.repo.get(id) ?? fail('路线不存在或已被删除'); }
  recent(limit: number) { return this.repo.recent(limit); }

  save(input: RouteInput): Route {
    const name = input.name.trim();
    if (!name) fail('请填写路线名称');
    const items = input.items.map(item => ({ ...item, id: item.id || randomUUID(), title: item.title.trim(), time: item.time.trim(), note: item.note.trim(), day: Math.max(1, Math.round(item.day)) })).filter(item => item.title);
    const invalidTime = items.find(item => item.time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(item.time));
    if (invalidTime) fail(`“${invalidTime.title}”的时间格式应为 HH:mm`);
    const linked = cleanList(items.map(item => item.materialId ?? ''));
    const existing = new Set(this.materials.getMany(linked).map(material => material.id));
    const days = Math.max(1, Math.round(input.days) || 1, ...items.map(item => item.day));
    const current = input.id ? this.repo.get(input.id) : null;
    if (input.id && !current) fail('路线不存在或已被删除');
    return this.repo.save({
      id: current?.id ?? randomUUID(), createdAt: current?.createdAt, name, city: input.city.trim(), days, tags: cleanList(input.tags), summary: input.summary.trim(),
      status: input.status === 'disabled' ? 'disabled' : 'enabled',
      items: items.map(item => ({ ...item, materialId: item.materialId && existing.has(item.materialId) ? item.materialId : undefined })),
    });
  }

  delete(id: string) { if (!this.repo.delete(id)) fail('路线不存在或已被删除'); }
}

// ───────── 内容中心 ─────────
// 状态机：草稿 → 待审核 → 已通过 → 已排期 → 已发送。修改已通过的内容会退回草稿重新审核。
export class ContentService {
  constructor(
    private readonly repo: ContentRepository,
    private readonly routes: RouteService,
    private readonly materials: MaterialService,
    private readonly generator: ContentGenerator,
    private readonly logs: LogService,
    private readonly tasksUsing: (contentId: string) => StoredTask[],
  ) {}

  list(status?: ContentStatus) { return this.repo.list(status); }
  versions(id: string): ContentVersion[] { return this.repo.versions(id); }
  get(id: string) { return this.repo.get(id) ?? fail('内容不存在或已被删除'); }
  count(status: ContentStatus) { return this.repo.count(status); }

  save(input: ContentInput): ContentPiece {
    const title = input.title.trim(); const body = input.body.trim();
    if (!title || !body) fail('标题和正文都不能为空');
    if (!CONTENT_CHANNELS.includes(input.channel)) fail('内容类型不正确');
    if (!input.id) return this.repo.insert({ title, channel: input.channel, body, status: 'draft', source: 'manual', routeId: input.routeId, note: '人工新建' });
    const current = this.get(input.id);
    if (current.status === 'scheduled' || current.status === 'sent') fail(`内容${CONTENT_STATUS_LABELS[current.status]}，不能再修改。如需调整，请先取消相关运营任务，或新建一条内容`);
    const backToDraft = current.status === 'approved' && body !== current.body;
    return this.repo.update(current.id, { title, channel: input.channel, body, status: backToDraft ? 'draft' : current.status, reviewedAt: backToDraft ? null : undefined, routeId: input.routeId ?? null }, '人工编辑')!;
  }

  async generate(input: GenerateInput): Promise<ContentPiece> {
    const route = this.routes.get(input.routeId);
    const generated = await this.generator.generate({ route, materials: this.routeMaterials(route), channel: input.channel, variant: 0 });
    const piece = this.repo.insert({ title: generated.title, channel: input.channel, body: generated.body, status: 'draft', source: this.generator.source, routeId: route.id, note: '根据路线生成' });
    this.logs.write({ module: 'Content', action: '生成内容', status: 'ok', message: `根据路线“${route.name}”生成${input.channel}` });
    return piece;
  }

  async regenerate(id: string): Promise<ContentPiece> {
    const current = this.get(id);
    if (current.status === 'scheduled' || current.status === 'sent') fail('已排期或已发送的内容不能重新生成');
    if (!current.routeId) fail('这条内容没有关联路线，无法重新生成');
    const route = this.routes.get(current.routeId!);
    const generated = await this.generator.generate({ route, materials: this.routeMaterials(route), channel: current.channel, variant: current.version });
    return this.repo.update(id, { body: generated.body, status: 'draft', reviewedAt: null, source: this.generator.source }, '重新生成')!;
  }

  submit(id: string) { return this.transition(id, ['draft'], 'reviewing', '提交审核'); }
  approve(id: string) { return this.transition(id, ['reviewing'], 'approved', '审核通过'); }
  reject(id: string) { return this.transition(id, ['reviewing'], 'draft', '退回修改'); }

  delete(id: string) {
    const active = this.tasksUsing(id).filter(task => task.status === 'pending' || task.status === 'running');
    if (active.length) fail(`还有 ${active.length} 个运营任务在使用这条内容，请先取消任务`);
    if (!this.repo.delete(id)) fail('内容不存在或已被删除');
  }

  /** 运营任务调用：只有审核通过的内容才能排期。 */
  assertSendable(id: string): ContentPiece {
    const piece = this.get(id);
    if (!['approved', 'scheduled', 'sent'].includes(piece.status)) fail(`内容“${piece.title}”还未审核通过（当前：${CONTENT_STATUS_LABELS[piece.status]}）`);
    return piece;
  }
  /** 内容关联路线里素材的图片（攻略图、景点图），按路线顺序，RPA 发送时跟在文字后面。 */
  imagePaths(piece: ContentPiece): string[] {
    if (!piece.routeId) return [];
    let route: Route;
    try { route = this.routes.get(piece.routeId); } catch { return []; }
    const paths = this.routeMaterials(route).flatMap(material => material.images.map(image => this.materials.imageFile(image.id)));
    return cleanList(paths.filter((path): path is string => Boolean(path)));
  }
  markScheduled(id: string) { const piece = this.repo.get(id); if (piece?.status === 'approved') this.repo.update(id, { status: 'scheduled' }); }
  markSent(id: string) { const piece = this.repo.get(id); if (piece && piece.status !== 'sent') this.repo.update(id, { status: 'sent' }); }
  /** 相关任务全部取消且从未发送时，内容回到“已通过”，可以重新排期或修改。 */
  releaseIfIdle(id: string) {
    const piece = this.repo.get(id);
    if (piece?.status !== 'scheduled') return;
    if (!this.tasksUsing(id).some(task => task.status === 'pending' || task.status === 'running' || task.status === 'failed')) this.repo.update(id, { status: 'approved' });
  }

  /** 旧版“消息模板”迁移为内容中心里已通过的通知内容（只在内容中心为空时执行一次）。 */
  migrateTemplates(db: DatabaseSync) {
    if (!this.repo.isEmpty()) return;
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_templates'").get();
    if (!table) return;
    const columns = (db.prepare('PRAGMA table_info(message_templates)').all() as Array<{ name: string }>).map(column => column.name);
    const bodyColumn = columns.includes('body') ? 'body' : columns.includes('content') ? 'content' : null;
    if (!bodyColumn) return;
    const rows = db.prepare(`SELECT name, ${bodyColumn} AS body FROM message_templates`).all() as Array<{ name: string; body: string }>;
    for (const row of rows) if (row.name && row.body) this.repo.insert({ title: row.name, channel: '通知', body: row.body, status: 'approved', source: 'manual', note: '从消息模板迁移' });
  }

  private transition(id: string, from: ContentStatus[], to: ContentStatus, action: string) {
    const piece = this.get(id);
    if (!from.includes(piece.status)) fail(`当前状态是“${CONTENT_STATUS_LABELS[piece.status]}”，不能${action}`);
    const updated = this.repo.update(id, { status: to, reviewedAt: to === 'approved' ? nowIso() : undefined })!;
    this.logs.write({ module: 'Content', action, status: 'info', message: `“${piece.title}”${CONTENT_STATUS_LABELS[piece.status]} → ${CONTENT_STATUS_LABELS[to]}` });
    return updated;
  }

  private routeMaterials(route: Route): Material[] {
    return this.materials.getMany(cleanList(route.items.map(item => item.materialId ?? '')));
  }
}

// ───────── 发送方式（设置） ─────────
export class SendSettingsService {
  constructor(private readonly store: SendSettingsStore, private readonly rpa: DesktopRpaGateway, private readonly logs: LogService) {}

  get(): SendSettings { return this.store.get(); }

  save(input: SendSettings): SendSettings {
    const next: SendSettings = { mode: input?.mode === 'rpa' ? 'rpa' : 'api', rpa: normalizeRpa(input?.rpa) };
    const previous = this.store.get();
    this.store.save(next);
    if (previous.mode !== next.mode) this.logs.write({ module: 'System', action: '切换发送方式', status: 'info', message: next.mode === 'rpa' ? `客户群改为 RPA 发送（${RPA_CLIENT_LABELS[next.rpa.client]}桌面客户端）` : '客户群改为企业微信接口发送' });
    return next;
  }

  async checkRpa(override?: RpaSettings): Promise<string> {
    const settings = override ? normalizeRpa(override) : this.store.get().rpa;
    try {
      const detail = await this.rpa.check(settings);
      this.logs.write({ module: 'RPA', action: '检测客户端', status: 'ok', message: detail });
      return detail;
    } catch (error: any) {
      const message = error?.message || String(error);
      this.logs.write({ module: 'RPA', action: '检测客户端', status: 'fail', message });
      throw new OpsError(message);
    }
  }
}

function normalizeRpa(input?: Partial<RpaSettings>): RpaSettings {
  const base = DEFAULT_SEND_SETTINGS.rpa;
  const delay = Number(input?.stepDelayMs);
  return {
    client: input?.client === 'wechat' ? 'wechat' : 'wecom',
    autoSend: input?.autoSend ?? base.autoSend,
    sendKey: input?.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
    searchHotkey: String(input?.searchHotkey ?? '').trim() || base.searchHotkey,
    stepDelayMs: Number.isFinite(delay) ? Math.min(5000, Math.max(200, Math.round(delay))) : base.stepDelayMs,
    clientPath: String(input?.clientPath ?? '').trim(),
    guard: normalizeGuard(input?.guard),
  };
}

function normalizeGuard(input?: Partial<RpaGuard>): RpaGuard {
  const base = DEFAULT_SEND_SETTINGS.rpa.guard;
  const int = (value: unknown, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback; };
  const time = (value: unknown, fallback: string) => { const text = String(value ?? '').trim(); return /^([01]?\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback; };
  const gapMin = int(input?.groupGapMinSec, base.groupGapMinSec, 0, 600);
  return {
    groupGapMinSec: gapMin,
    groupGapMaxSec: Math.max(gapMin, int(input?.groupGapMaxSec, base.groupGapMaxSec, 0, 1800)),
    activeStart: time(input?.activeStart, base.activeStart),
    activeEnd: time(input?.activeEnd, base.activeEnd),
    maxPerHour: int(input?.maxPerHour, base.maxPerHour, 0, 1000),
    maxPerDay: int(input?.maxPerDay, base.maxPerDay, 0, 10000),
    maxPerGroupPerDay: int(input?.maxPerGroupPerDay, base.maxPerGroupPerDay, 0, 100),
    pauseAfterFailures: int(input?.pauseAfterFailures, base.pauseAfterFailures, 0, 20),
    pauseMinutes: int(input?.pauseMinutes, base.pauseMinutes, 1, 24 * 60),
    varyOpening: input?.varyOpening ?? base.varyOpening,
    maxImages: int(input?.maxImages, base.maxImages, 0, 9),
  };
}

// ───────── 群管理 ─────────
export class GroupService {
  constructor(private readonly repo: GroupRepository, private readonly bot: BotGateway, private readonly customer: CustomerGroupGateway, private readonly logs: LogService, private readonly distribution: () => DistributionService, private readonly sendSettings: () => SendSettings) {}

  list(): OpsGroup[] { return this.repo.list().map(group => ({ ...group, todaySent: this.logs.sentToday(group.name) })); }
  get(id: string): OpsGroup { const group = this.repo.get(id) ?? fail('群不存在或已被删除'); return { ...group, todaySent: this.logs.sentToday(group.name) }; }
  getMany(ids: string[]): OpsGroup[] { return ids.map(id => this.repo.get(id)).filter((group): group is NonNullable<typeof group> => Boolean(group)).map(group => ({ ...group, todaySent: 0 })); }
  markSent(id: string) { this.repo.markSent(id, nowIso()); }

  /** 从企业微信拉取群列表并与本地合并：按 chatId 匹配；“按群名匹配”的群在 chatId 变化后也能接上。 */
  async refresh(): Promise<RefreshResult> {
    const warnings: string[] = [];
    const fetched: Array<{ chatId: string; name: string; channel: 'bot' | 'customer'; owner: string; memberCount: number }> = [];
    let botOk = false; let customerOk = false;
    try { (await this.bot.listGroups()).forEach(group => fetched.push({ ...group, channel: 'bot', owner: '', memberCount: 0 })); botOk = true; }
    catch (error: any) { warnings.push(`机器人群聊加载失败：${error?.message || error}`); }
    if (this.customer.configured()) {
      const sender = this.customer.defaultSender();
      try { (await this.customer.listGroups(sender ? [sender] : [])).forEach(group => fetched.push({ ...group, channel: 'customer' })); customerOk = true; }
      catch (error: any) { warnings.push(`客户群加载失败：${error?.message || error}`); }
    } else if (this.sendSettings().mode === 'api') warnings.push('还没有配置客户群群发（企业 ID、Secret、发送人），只加载了机器人群聊');

    const existing = this.repo.list();
    const matched = new Set<string>();
    let added = 0; let updated = 0;
    for (const item of fetched) {
      const sameChannel = existing.filter(group => group.channel === item.channel && !matched.has(group.id));
      const found = sameChannel.find(group => group.chatId === item.chatId) ?? sameChannel.find(group => group.matchMode === 'name' && group.name === item.name);
      if (found) { matched.add(found.id); this.repo.upsert({ ...found, chatId: item.chatId, name: item.name, owner: item.owner, memberCount: item.memberCount, available: true }); updated += 1; }
      else { const id = randomUUID(); matched.add(id); this.repo.upsert({ id, chatId: item.chatId, name: item.name, channel: item.channel, owner: item.owner, memberCount: item.memberCount, enabled: true, matchMode: 'id', available: true }); added += 1; }
    }
    let missing = 0;
    for (const group of existing) {
      const loaded = group.channel === 'bot' ? botOk : customerOk;
      if (!matched.has(group.id) && loaded && group.available && !isManualGroup(group)) { this.repo.upsert({ ...group, available: false }); missing += 1; }
    }
    this.logs.write({ module: 'Group', action: '刷新群列表', status: warnings.length && !fetched.length ? 'fail' : 'ok', message: `新增 ${added}，更新 ${updated}，找不到 ${missing}`, detail: warnings.join('\n') || undefined });
    return { added, updated, missing, warnings };
  }

  update(input: { id: string; enabled?: boolean; matchMode?: GroupMatchMode }): OpsGroup {
    const group = this.repo.get(input.id) ?? fail('群不存在或已被删除');
    this.repo.upsert({ ...group, enabled: input.enabled ?? group.enabled, matchMode: input.matchMode === 'name' || input.matchMode === 'id' ? input.matchMode : group.matchMode });
    return this.get(group.id);
  }

  /** 手动添加客户群：RPA 按群名搜索发送，不需要接口。按群名匹配，以后接口能拉到同名群时会自动接上。 */
  add(names: string[]): OpsGroup[] {
    const wanted = cleanList(Array.isArray(names) ? names.map(String) : []);
    if (!wanted.length) fail('请填写群名称');
    const existing = new Set(this.repo.list().filter(group => group.channel === 'customer').map(group => group.name));
    const added: OpsGroup[] = [];
    for (const name of wanted) {
      if (existing.has(name)) continue;
      const id = randomUUID();
      this.repo.upsert({ id, chatId: `${MANUAL_CHAT_PREFIX}${id}`, name, channel: 'customer', owner: '', memberCount: 0, enabled: true, matchMode: 'name', available: true });
      existing.add(name);
      added.push(this.get(id));
    }
    this.logs.write({ module: 'Group', action: '手动添加群', status: 'ok', message: `新增 ${added.length} 个，跳过已存在 ${wanted.length - added.length} 个`, detail: added.map(group => group.name).join('、') || undefined });
    return added;
  }

  delete(id: string) {
    const group = this.repo.get(id) ?? fail('群不存在或已被删除');
    if (!isManualGroup(group)) fail('只能删除手动添加的群；接口加载的群请用“停用”');
    this.repo.delete(id);
    this.logs.write({ module: 'Group', action: '删除群', status: 'ok', message: group.name });
  }

  async testSend(id: string, text: string): Promise<string> {
    const group = this.get(id);
    if (!text.trim()) fail('测试内容不能为空');
    const result = await this.distribution().send(group, text.trim(), { action: '测试发送' });
    if (!result.ok) fail(result.detail);
    return result.detail;
  }
}

// ───────── 分发适配（怎么发） ─────────
export type SendResult = { ok: boolean; detail: string };

/** 防封规则拦下的发送：不算 RPA 故障，不触发熔断。 */
class GuardBlocked extends Error {}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);
function minutesOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
/** 不在发送时段时返回下一个时段开始的时间，在时段内返回 null。支持跨零点（如 22:00–02:00）。 */
export function nextActiveStart(guard: RpaGuard, now: Date): Date | null {
  const start = minutesOf(guard.activeStart); const end = minutesOf(guard.activeEnd);
  if (start === null || end === null || start === end) return null;
  const current = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (inside) return null;
  const next = new Date(now); next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}
const GREETINGS = { morning: '早上好', noon: '中午好', afternoon: '下午好', evening: '晚上好' };
/** 开头随机加一句问候，让不同群收到的文字略有不同。 */
function varyOpening(text: string, now: Date): string {
  const hour = now.getHours();
  const word = hour < 11 ? GREETINGS.morning : hour < 14 ? GREETINGS.noon : hour < 18 ? GREETINGS.afternoon : GREETINGS.evening;
  const forms = [`${word}～`, `大家${word}！`, `各位${word}`, `${word}呀`, `亲们${word}～`, `Hi 各位，${word}`];
  return `${forms[Math.floor(Math.random() * forms.length)]}\n${text}`;
}

export class DistributionService {
  /** RPA 熔断状态：连续失败次数、暂停到什么时候、上一次发出的时间（控制群间隔）。 */
  private rpaFailures = 0;
  private rpaPausedUntil = 0;
  private rpaLastSentAt = 0;

  constructor(private readonly bot: BotGateway, private readonly customer: CustomerGroupGateway, private readonly rpa: DesktopRpaGateway, private readonly sendSettings: () => SendSettings, private readonly logs: LogService, private readonly onSent: (groupId: string) => void) {}

  /** 预演：做发送前的全部检查，客户群还会用只读接口确认凭证、可信 IP 和群是否还在，但不创建群发任务。 */
  async dryRun(groups: OpsGroup[], context: { taskId?: string; imageCount?: number }): Promise<DryRunGroup[]> {
    const results: DryRunGroup[] = [];
    let botChats: Set<string> | null | Error = null;
    const customerChats = new Map<string, Set<string> | Error>();
    const settings = this.sendSettings();
    let rpaCheck: string | Error | null = null;
    for (const group of groups) {
      const result = (ok: boolean, detail: string) => {
        results.push({ name: group.name, channel: group.channel, ok, detail });
        this.logs.write({ module: 'WeCom', action: '预演', status: ok ? 'info' : 'fail', taskId: context.taskId, groupName: group.name, message: `【预演，未发送】${detail}` });
      };
      if (!group.enabled) { result(false, '群已停用，正式执行时会跳过'); continue; }
      if (!group.available) { result(false, '找不到群（最近一次刷新时已不在列表中），请到群管理刷新'); continue; }
      if (group.channel === 'bot') {
        if (botChats === null) botChats = await this.bot.listGroups().then(list => new Set(list.map(item => item.chatId)), error => (error instanceof Error ? error : new Error(String(error))));
        if (botChats instanceof Error) result(false, `机器人会话列表加载失败：${botChats.message}`);
        else if (!botChats.has(group.chatId)) result(false, '机器人当前的会话列表里没有这个群');
        else result(true, '机器人在群里，正式执行时会直接发出');
        continue;
      }
      if (settings.mode === 'rpa') {
        const label = RPA_CLIENT_LABELS[settings.rpa.client];
        const blocked = this.guardBlock(group, new Date());
        if (blocked) { result(false, `防封规则：${blocked}`); continue; }
        if (rpaCheck === null) rpaCheck = await this.rpa.check().catch(error => (error instanceof Error ? error : new Error(String(error))));
        if (rpaCheck instanceof Error) result(false, rpaCheck.message);
        else {
          const images = Math.min(context.imageCount ?? 0, settings.rpa.guard.maxImages);
          result(true, `${label}客户端正常，正式执行时会在${label}里搜索“${group.name}”，${images ? `发文字和 ${images} 张图` : '发文字'}并${settings.rpa.autoSend ? '自动发送' : '粘贴到输入框，等人工按发送'}`);
        }
        continue;
      }
      if (isManualGroup(group)) { result(false, '手动添加的群只能用 RPA 发送，请在设置里切换到“桌面客户端（RPA）”'); continue; }
      if (!this.customer.configured()) { result(false, '还没有配置客户群群发（设置 → 客户群群发）'); continue; }
      const sender = group.owner || this.customer.defaultSender();
      if (!sender) { result(false, '缺少群主 userid'); continue; }
      if (!customerChats.has(sender)) customerChats.set(sender, await this.customer.listGroups([sender]).then(list => new Set(list.map(item => item.chatId)), error => (error instanceof Error ? error : new Error(String(error)))));
      const chats = customerChats.get(sender)!;
      if (chats instanceof Error) result(false, `企业微信接口校验失败：${chats.message}`);
      else if (!chats.has(group.chatId)) result(false, `群主 ${sender} 名下找不到这个客户群`);
      else result(true, `接口和群都正常，正式执行时会创建群发任务，由群主 ${sender} 在企业微信确认后发出`);
    }
    return results;
  }

  /** RPA 模式下当前不能发（时段外或熔断暂停中）时，返回可以重新尝试的时间，供运营任务顺延。 */
  rpaDeferUntil(now: Date): Date | null {
    const settings = this.sendSettings();
    if (settings.mode !== 'rpa') return null;
    if (this.rpaPausedUntil > now.getTime()) return new Date(this.rpaPausedUntil);
    return nextActiveStart(settings.rpa.guard, now);
  }

  /** 防封规则检查：返回拦截原因，可以发时返回 null。 */
  private guardBlock(group: OpsGroup, now: Date): string | null {
    const guard = this.sendSettings().rpa.guard;
    if (this.rpaPausedUntil > now.getTime()) return `RPA 连续失败后暂停中，${fmt(new Date(this.rpaPausedUntil))} 后恢复`;
    if (nextActiveStart(guard, now)) return `不在发送时段（${guard.activeStart}–${guard.activeEnd}）`;
    if (guard.maxPerHour > 0 && this.logs.rpaSentSince(new Date(now.getTime() - 3600 * 1000)) >= guard.maxPerHour) return `最近一小时已发 ${guard.maxPerHour} 次，达到上限`;
    const today = startOfLocalDay(now);
    if (guard.maxPerDay > 0 && this.logs.rpaSentSince(today) >= guard.maxPerDay) return `今天已发 ${guard.maxPerDay} 次，达到每日上限`;
    if (guard.maxPerGroupPerDay > 0 && this.logs.rpaSentSince(today, group.name) >= guard.maxPerGroupPerDay) return `这个群今天已发 ${guard.maxPerGroupPerDay} 次，达到单群上限`;
    return null;
  }

  private async sendViaRpa(group: OpsGroup, text: string, images: string[], context: { taskId?: string }): Promise<{ sent: boolean; images: number }> {
    const settings = this.sendSettings(); const guard = settings.rpa.guard;
    const blocked = this.guardBlock(group, new Date());
    if (blocked) throw new GuardBlocked(`防封规则：${blocked}，本次未发送`);
    // 运营任务连发多个群时，群与群之间随机停一会儿，像人一样一个个发
    if (context.taskId && this.rpaLastSentAt) {
      const gapMs = randomBetween(guard.groupGapMinSec, Math.max(guard.groupGapMinSec, guard.groupGapMaxSec)) * 1000;
      const wait = this.rpaLastSentAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const attachments = images.slice(0, Math.max(0, guard.maxImages));
    try {
      const result = await this.rpa.sendText(group.name, guard.varyOpening ? varyOpening(text, new Date()) : text, attachments);
      this.rpaFailures = 0;
      return { sent: result.sent, images: attachments.length };
    } catch (error) {
      this.rpaFailures += 1;
      if (guard.pauseAfterFailures > 0 && this.rpaFailures >= guard.pauseAfterFailures) {
        this.rpaPausedUntil = Date.now() + Math.max(1, guard.pauseMinutes) * 60 * 1000;
        this.rpaFailures = 0;
        this.logs.write({ module: 'RPA', action: '熔断暂停', status: 'fail', taskId: context.taskId, message: `连续失败 ${guard.pauseAfterFailures} 次，RPA 暂停到 ${fmt(new Date(this.rpaPausedUntil))}，请检查客户端是否掉线或弹出了验证` });
      }
      throw error;
    } finally {
      this.rpaLastSentAt = Date.now();
    }
  }

  async send(group: OpsGroup, text: string, context: { taskId?: string; attempt?: number; action?: string; images?: string[] }): Promise<SendResult> {
    const base = { module: 'WeCom' as const, taskId: context.taskId, groupName: group.name, attempt: context.attempt };
    const action = context.action ?? '发送文本';
    if (!group.enabled) { this.logs.write({ ...base, action, status: 'fail', message: '群已停用，跳过' }); return { ok: false, detail: `${group.name}：群已停用` }; }
    if (!group.available) { this.logs.write({ ...base, action, status: 'fail', message: '找不到群（最近一次刷新时已不在列表中）' }); return { ok: false, detail: `${group.name}：找不到群，请到群管理刷新` }; }
    try {
      if (group.channel === 'bot') {
        await this.bot.sendText(group.chatId, text);
        this.logs.write({ ...base, action, status: 'ok', message: '机器人已发送' });
        this.onSent(group.id);
        return { ok: true, detail: `${group.name}：已发送` };
      }
      const settings = this.sendSettings();
      if (settings.mode === 'rpa') {
        const label = RPA_CLIENT_LABELS[settings.rpa.client];
        const { sent, images } = await this.sendViaRpa(group, text, context.images ?? [], context);
        const what = images ? `文字和 ${images} 张图` : '文字';
        this.logs.write({ ...base, module: 'RPA', action, status: 'ok', message: sent ? `已通过${label}客户端发送${what}` : `已把${what}粘贴到${label}输入框，等待人工按发送` });
        this.onSent(group.id);
        return { ok: true, detail: `${group.name}：${sent ? `已通过${label}发送${what}` : `已粘贴到${label}，请人工按发送`}` };
      }
      if (isManualGroup(group)) throw new Error('手动添加的群只能用 RPA 发送，请在设置里切换到“桌面客户端（RPA）”');
      if (!this.customer.configured()) throw new Error('还没有配置客户群群发（设置 → 客户群群发）');
      const sender = group.owner || this.customer.defaultSender();
      if (!sender) throw new Error('缺少群主 userid');
      const { msgid, failList } = await this.customer.createGroupMessage({ sender, chatIds: [group.chatId], content: text });
      if (failList.includes(group.chatId)) throw new Error('企业微信拒绝向该客户群创建群发任务');
      this.logs.write({ ...base, action, status: 'ok', message: `已创建群发任务，等待群主 ${sender} 在企业微信确认`, detail: `msgid=${msgid}` });
      this.onSent(group.id);
      return { ok: true, detail: `${group.name}：已创建群发任务，等待群主确认` };
    } catch (error: any) {
      const message = error?.message || String(error);
      const module = group.channel === 'customer' && this.sendSettings().mode === 'rpa' ? 'RPA' : 'WeCom';
      this.logs.write({ ...base, module, action, status: 'fail', message });
      return { ok: false, detail: `${group.name}：${message}` };
    }
  }
}

// ───────── 运营任务（什么时候、把什么内容、发给谁） ─────────
/** 超过这个时间还没执行（电脑关机、程序没开），就视为错过，不再补发。 */
const MISSED_AFTER_MS = 2 * 3600 * 1000;
const AUTO_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_AUTO_ATTEMPTS = 2;

export function nextOccurrence(anchorIso: string, repeat: TaskRepeat, after: Date): Date | null {
  const next = new Date(anchorIso);
  if (repeat === 'once') return next > after ? next : null;
  const stepDays = repeat === 'daily' ? 1 : 7;
  while (next <= after) next.setDate(next.getDate() + stepDays);
  return next;
}

export class TaskService {
  private running = false;

  constructor(
    private readonly repo: TaskRepository,
    private readonly contents: ContentService,
    private readonly groups: GroupService,
    private readonly distribution: DistributionService,
    private readonly weather: WeatherGateway,
    private readonly logs: LogService,
  ) {}

  list(status?: TaskStatus): OpsTask[] { return this.repo.list(status).map(task => this.view(task)); }
  runs(id: string): TaskRun[] { return this.repo.runs(id); }
  usingContent(contentId: string) { return this.repo.byContent(contentId); }
  runsBetween(from: Date, to: Date) { return this.repo.runsBetween(from.toISOString(), to.toISOString()); }
  rawList() { return this.repo.list(); }

  create(input: TaskInput): OpsTask {
    const content = this.contents.assertSendable(input.contentId);
    const groupIds = cleanList(input.groupIds);
    if (!groupIds.length) fail('请至少选择一个群');
    const groups = this.groups.getMany(groupIds);
    if (groups.length !== groupIds.length) fail('部分群已不存在，请刷新后重选');
    const disabled = groups.find(group => !group.enabled);
    if (disabled) fail(`群“${disabled.name}”已停用`);
    const runAt = new Date(input.runAt);
    if (Number.isNaN(runAt.getTime())) fail('请选择发送时间');
    if (!['once', 'daily', 'weekly'].includes(input.repeat)) fail('执行方式不正确');
    const now = new Date();
    if (input.repeat === 'once' && runAt.getTime() < now.getTime() - 60 * 1000) fail('发送时间已经过去了');
    const first = input.repeat === 'once' ? runAt : nextOccurrence(runAt.toISOString(), input.repeat, new Date(now.getTime() - 60 * 1000))!;
    const task: StoredTask = { id: randomUUID(), contentId: content.id, groupIds, runAt: runAt.toISOString(), repeat: input.repeat, weatherCity: input.weatherCity.trim(), status: 'pending', nextRunAt: first.toISOString(), attempts: 0, retryGroupIds: [], createdAt: nowIso() };
    this.repo.save(task);
    this.contents.markScheduled(content.id);
    this.logs.write({ module: 'Scheduler', action: '创建任务', status: 'ok', taskId: task.id, message: `“${content.title}” → ${groups.map(group => group.name).join('、')}，${fmt(first)}` });
    return this.view(task);
  }

  cancel(id: string): OpsTask {
    const task = this.get(id);
    if (task.status === 'running') fail('任务正在执行，请稍后再取消');
    if (task.status === 'cancelled' || task.status === 'success') fail('任务已结束，无需取消');
    const updated = { ...task, status: 'cancelled' as const, nextRunAt: undefined, retryGroupIds: [] };
    this.repo.save(updated);
    this.contents.releaseIfIdle(task.contentId);
    this.logs.write({ module: 'Scheduler', action: '取消任务', status: 'info', taskId: id, message: '任务已取消' });
    return this.view(updated);
  }

  retry(id: string): OpsTask {
    const task = this.get(id);
    if (task.status !== 'failed') fail('只有失败的任务可以重试');
    const updated = { ...task, status: 'pending' as const, nextRunAt: nowIso(), attempts: 0 };
    this.repo.save(updated);
    this.logs.write({ module: 'Scheduler', action: '手动重试', status: 'info', taskId: id, message: updated.retryGroupIds.length ? `只补发失败的 ${updated.retryGroupIds.length} 个群` : '重新发送' });
    void this.runDue();
    return this.view(updated);
  }

  async dryRun(input: { id: string } | TaskInput): Promise<DryRunReport> {
    const draft: Pick<StoredTask, 'contentId' | 'groupIds' | 'weatherCity'> & { id?: string } = 'id' in input && input.id
      ? this.get(input.id)
      : { contentId: (input as TaskInput).contentId, groupIds: cleanList((input as TaskInput).groupIds ?? []), weatherCity: String((input as TaskInput).weatherCity ?? '').trim() };
    if (!draft.groupIds.length) fail('请至少选择一个群');
    const content = this.contents.assertSendable(draft.contentId);
    const text = await this.compose(content.body, draft.weatherCity, new Date(), draft.id);
    const groups = this.groups.getMany(draft.groupIds);
    const missing = draft.groupIds.length - groups.length;
    const results = await this.distribution.dryRun(groups, { taskId: draft.id, imageCount: this.contents.imagePaths(content).length });
    for (let index = 0; index < missing; index += 1) results.push({ name: '（已删除的群）', channel: 'bot', ok: false, detail: '群已被删除' });
    const ok = results.every(item => item.ok);
    this.logs.write({ module: 'Task', action: '预演', status: ok ? 'ok' : 'fail', taskId: draft.id, message: `【预演，未发送】“${content.title}”：${results.filter(item => item.ok).length}/${results.length} 个群检查通过` });
    return { contentTitle: content.title, text, groups: results, ok, checkedAt: nowIso() };
  }

  private async compose(body: string, weatherCity: string, now: Date, taskId?: string): Promise<string> {
    if (!weatherCity) return body;
    try { return `${body}\n\n${await this.weather.forecastLine(weatherCity, now)}`; }
    catch (error: any) { this.logs.write({ module: 'Task', action: '获取天气', status: 'fail', taskId, message: `${weatherCity}天气获取失败，本次不附天气：${error?.message || error}` }); return body; }
  }

  async runNow(id: string): Promise<OpsTask> {
    const task = this.get(id);
    if (task.status !== 'pending') fail('只有待执行的任务可以立即执行');
    await this.execute(task, new Date());
    return this.view(this.get(id));
  }

  delete(id: string) {
    const task = this.get(id);
    if (task.status === 'running') fail('任务正在执行，请稍后再删除');
    this.repo.delete(id);
    this.contents.releaseIfIdle(task.contentId);
  }

  /** 调度器每分钟调用：执行到点的任务。 */
  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      for (const task of this.repo.due(now.toISOString())) await this.execute(task, now);
    } finally { this.running = false; }
  }

  recoverAfterRestart() { this.repo.resetRunning(); }

  private async execute(task: StoredTask, now: Date) {
    const dueAt = new Date(task.nextRunAt ?? task.runAt);
    const isRetry = task.retryGroupIds.length > 0 || task.attempts > 0;
    if (!isRetry && now.getTime() - dueAt.getTime() > MISSED_AFTER_MS) return this.skipMissed(task, dueAt, now);

    const targetIds = task.retryGroupIds.length ? task.retryGroupIds : task.groupIds;
    const groups = this.groups.getMany(targetIds);
    // RPA 防封：时段外或熔断暂停中，整个任务顺延，不算失败、不占重试次数
    const deferUntil = groups.some(group => group.channel === 'customer') ? this.distribution.rpaDeferUntil(now) : null;
    if (deferUntil) {
      this.repo.save({ ...task, status: 'pending', nextRunAt: deferUntil.toISOString(), lastResult: `RPA 防封：顺延到 ${fmt(deferUntil)}` });
      this.logs.write({ module: 'RPA', action: '顺延任务', status: 'info', taskId: task.id, message: `当前不在 RPA 发送时段或暂停中，任务顺延到 ${fmt(deferUntil)}` });
      return;
    }

    this.repo.save({ ...task, status: 'running' });
    const attempt = task.attempts + 1;
    const startedAt = new Date();
    this.logs.write({ module: 'Scheduler', action: '开始执行', status: 'info', taskId: task.id, attempt, message: `第 ${attempt} 次执行` });

    let text = '';
    let images: string[] = [];
    try {
      const content = this.contents.assertSendable(task.contentId);
      text = await this.compose(content.body, task.weatherCity, now, task.id);
      images = this.contents.imagePaths(content);
    } catch (error: any) {
      return this.finish(task, startedAt, attempt, [], [error?.message || String(error)], task.groupIds);
    }

    const missing = targetIds.filter(id => !groups.some(group => group.id === id));
    const okDetails: string[] = []; const failDetails: string[] = missing.map(() => '群已被删除'); const failedIds: string[] = [];
    for (const group of groups) {
      const result = await this.distribution.send(group, text, { taskId: task.id, attempt, images });
      if (result.ok) okDetails.push(result.detail); else { failDetails.push(result.detail); failedIds.push(group.id); }
    }
    this.finish(task, startedAt, attempt, okDetails, failDetails, failedIds);
  }

  private finish(task: StoredTask, startedAt: Date, attempt: number, okDetails: string[], failDetails: string[], failedIds: string[]) {
    const now = new Date();
    const detail = [...okDetails, ...failDetails].join('\n');
    if (!failDetails.length) {
      const next = task.repeat === 'once' ? null : nextOccurrence(task.runAt, task.repeat, now);
      this.repo.save({ ...task, status: next ? 'pending' : 'success', nextRunAt: next?.toISOString(), lastRunAt: startedAt.toISOString(), lastResult: `成功：${okDetails.length} 个群`, attempts: 0, retryGroupIds: [] });
      this.repo.addRun({ taskId: task.id, startedAt: startedAt.toISOString(), status: 'success', detail });
      this.logs.write({ module: 'Task', action: '执行任务', status: 'ok', taskId: task.id, attempt, message: `发送成功（${okDetails.length} 个群）`, detail });
      if (!next) this.contents.markSent(task.contentId);
      return;
    }
    const autoRetry = attempt < MAX_AUTO_ATTEMPTS && failedIds.length > 0;
    const summary = `失败 ${failDetails.length} 个，成功 ${okDetails.length} 个`;
    this.repo.save({
      ...task, lastRunAt: startedAt.toISOString(), attempts: attempt, retryGroupIds: failedIds.length ? failedIds : task.groupIds,
      status: autoRetry ? 'pending' : 'failed', nextRunAt: autoRetry ? new Date(now.getTime() + AUTO_RETRY_DELAY_MS).toISOString() : undefined,
      lastResult: autoRetry ? `${summary}，5 分钟后自动重试失败的群` : `${summary}：${failDetails[0]}`,
    });
    this.repo.addRun({ taskId: task.id, startedAt: startedAt.toISOString(), status: 'failed', detail });
    this.logs.write({ module: 'Task', action: '执行任务', status: 'fail', taskId: task.id, attempt, message: autoRetry ? `${summary}，将自动重试` : summary, detail });
  }

  private skipMissed(task: StoredTask, dueAt: Date, now: Date) {
    const message = `错过了 ${fmt(dueAt)} 的发送（电脑关机或程序未运行），已跳过`;
    const next = task.repeat === 'once' ? null : nextOccurrence(task.runAt, task.repeat, now);
    this.repo.save({ ...task, status: next ? 'pending' : 'failed', nextRunAt: next?.toISOString(), lastResult: message, attempts: 0, retryGroupIds: [] });
    this.repo.addRun({ taskId: task.id, startedAt: now.toISOString(), status: 'skipped', detail: message });
    this.logs.write({ module: 'Scheduler', action: '错过发送', status: 'fail', taskId: task.id, message });
  }

  private get(id: string): StoredTask { return this.repo.get(id) ?? fail('任务不存在或已被删除'); }

  private view(task: StoredTask): OpsTask {
    const content = this.contents.list().find(piece => piece.id === task.contentId);
    const groups = this.groups.getMany(task.groupIds);
    const { retryGroupIds: _retry, ...rest } = task;
    return { ...rest, contentTitle: content?.title ?? '（内容已删除）', groupNames: groups.map(group => group.name) };
  }
}

// ───────── 首页（只读汇总） ─────────
export class DashboardService {
  constructor(private readonly tasks: TaskService, private readonly contents: ContentService, private readonly routes: RouteService, private readonly groups: GroupService) {}

  get(): Dashboard {
    const start = startOfLocalDay(new Date()); const end = new Date(start); end.setDate(end.getDate() + 1);
    const runs = this.tasks.runsBetween(start, end);
    const tasks = this.tasks.list();
    const byId = new Map(tasks.map(task => [task.id, task]));
    const todayTasks: DashboardTask[] = runs.map(run => {
      const task = byId.get(run.taskId);
      return { taskId: run.taskId, time: run.startedAt, title: task?.contentTitle ?? '（任务已删除）', groupNames: task?.groupNames ?? [], status: run.status === 'skipped' ? 'skipped' : run.status };
    });
    const upcoming = tasks.filter(task => task.status === 'pending' && task.nextRunAt && new Date(task.nextRunAt) < end);
    upcoming.forEach(task => todayTasks.push({ taskId: task.id, time: task.nextRunAt!, title: task.contentTitle, groupNames: task.groupNames, status: 'pending' }));
    todayTasks.sort((a, b) => a.time.localeCompare(b.time));
    return {
      today: start.toISOString(),
      reviewing: this.contents.count('reviewing'),
      pendingToday: upcoming.length,
      successToday: runs.filter(run => run.status === 'success').length,
      failedToday: runs.filter(run => run.status !== 'success').length,
      todayTasks,
      recentRoutes: this.routes.recent(5).map(route => ({ id: route.id, name: route.name, city: route.city, days: route.days, tags: route.tags })),
    };
  }
}

