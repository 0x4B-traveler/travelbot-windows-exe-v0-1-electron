import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTENT_CHANNELS, CONTENT_STATUS_LABELS, MATERIAL_KIND_LABELS,
  type ContentChannel, type ContentInput, type ContentPiece, type ContentStatus, type ContentVersion, type Dashboard, type DashboardTask,
  type GenerateInput, type GroupMatchMode, type ImportResult, type LogEntry, type LogQuery, type Material, type MaterialFacets,
  type MaterialInput, type MaterialKind, type MaterialQuery, type OpsGroup, type OpsTask, type RefreshResult, type Route, type RouteInput,
  type RouteQuery, type TaskInput, type TaskRepeat, type TaskRun, type TaskStatus,
} from '../../src/domain/ops';
import { ContentRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TaskRepository, type StoredTask } from '../infrastructure/repositories';
import type { BotGateway, ContentGenerator, CustomerGroupGateway, FilePicker, FileStore, WeatherGateway } from './ports';

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

// ───────── 群管理 ─────────
export class GroupService {
  constructor(private readonly repo: GroupRepository, private readonly bot: BotGateway, private readonly customer: CustomerGroupGateway, private readonly logs: LogService, private readonly distribution: () => DistributionService) {}

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
    } else warnings.push('还没有配置客户群群发（企业 ID、Secret、发送人），只加载了机器人群聊');

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
      if (!matched.has(group.id) && loaded && group.available) { this.repo.upsert({ ...group, available: false }); missing += 1; }
    }
    this.logs.write({ module: 'Group', action: '刷新群列表', status: warnings.length && !fetched.length ? 'fail' : 'ok', message: `新增 ${added}，更新 ${updated}，找不到 ${missing}`, detail: warnings.join('\n') || undefined });
    return { added, updated, missing, warnings };
  }

  update(input: { id: string; enabled?: boolean; matchMode?: GroupMatchMode }): OpsGroup {
    const group = this.repo.get(input.id) ?? fail('群不存在或已被删除');
    this.repo.upsert({ ...group, enabled: input.enabled ?? group.enabled, matchMode: input.matchMode === 'name' || input.matchMode === 'id' ? input.matchMode : group.matchMode });
    return this.get(group.id);
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

export class DistributionService {
  constructor(private readonly bot: BotGateway, private readonly customer: CustomerGroupGateway, private readonly logs: LogService, private readonly onSent: (groupId: string) => void) {}

  async send(group: OpsGroup, text: string, context: { taskId?: string; attempt?: number; action?: string }): Promise<SendResult> {
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
      this.logs.write({ ...base, action, status: 'fail', message });
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

    this.repo.save({ ...task, status: 'running' });
    const attempt = task.attempts + 1;
    const startedAt = new Date();
    this.logs.write({ module: 'Scheduler', action: '开始执行', status: 'info', taskId: task.id, attempt, message: `第 ${attempt} 次执行` });

    let text = '';
    try {
      const content = this.contents.assertSendable(task.contentId);
      text = content.body;
      if (task.weatherCity) {
        try { text = `${text}\n\n${await this.weather.forecastLine(task.weatherCity, now)}`; }
        catch (error: any) { this.logs.write({ module: 'Task', action: '获取天气', status: 'fail', taskId: task.id, message: `${task.weatherCity}天气获取失败，本次不附天气：${error?.message || error}` }); }
      }
    } catch (error: any) {
      return this.finish(task, startedAt, attempt, [], [error?.message || String(error)], task.groupIds);
    }

    const targetIds = task.retryGroupIds.length ? task.retryGroupIds : task.groupIds;
    const groups = this.groups.getMany(targetIds);
    const missing = targetIds.filter(id => !groups.some(group => group.id === id));
    const okDetails: string[] = []; const failDetails: string[] = missing.map(() => '群已被删除'); const failedIds: string[] = [];
    for (const group of groups) {
      const result = await this.distribution.send(group, text, { taskId: task.id, attempt });
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

