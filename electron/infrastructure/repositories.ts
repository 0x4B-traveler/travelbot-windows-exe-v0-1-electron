import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ContentChannel, ContentPiece, ContentSource, ContentStatus, ContentVersion, GroupChannel, GroupMatchMode, LogEntry, LogQuery,
  Material, MaterialImage, MaterialKind, MaterialQuery, MaterialSource, OpsGroup, OpsTask, Route, RouteItem, RouteQuery, RouteStatus,
  TaskRepeat, TaskRun, TaskStatus,
} from '../../src/domain/ops';

// Infrastructure：只负责把领域对象存进 SQLite / 从 SQLite 读出来，不含业务规则。

export function migrateOpsSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', days INTEGER NOT NULL DEFAULT 1,
      tags TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'enabled',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_items (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE, day INTEGER NOT NULL,
      time TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, material_id TEXT, note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS contents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      source TEXT NOT NULL, route_id TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS content_versions (
      content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE, version INTEGER NOT NULL, body TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (content_id, version)
    );
    CREATE TABLE IF NOT EXISTS ops_groups (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, channel TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
      member_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, match_mode TEXT NOT NULL DEFAULT 'id',
      available INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ops_tasks (
      id TEXT PRIMARY KEY, content_id TEXT NOT NULL, group_ids TEXT NOT NULL DEFAULT '[]', run_at TEXT NOT NULL, repeat TEXT NOT NULL,
      weather_city TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, last_result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, retry_group_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_started ON task_runs(started_at);
    CREATE TABLE IF NOT EXISTS ops_logs (
      id TEXT PRIMARY KEY, time TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
      task_id TEXT, group_name TEXT, attempt INTEGER, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ops_logs_time ON ops_logs(time);
  `);
  // 素材表来自旧版本，补上“来源”列
  const columns = db.prepare('PRAGMA table_info(content_items)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'source')) db.exec("ALTER TABLE content_items ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  db.exec('PRAGMA foreign_keys = ON;');
}

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
function parseList(value: string | null | undefined): string[] {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; }
}
const like = (value: string) => `%${value.trim()}%`;

// ───────── 素材 ─────────
type MaterialRow = { id: string; kind: MaterialKind; title: string; body: string; location: string | null; tags: string; source: MaterialSource | null; created_at: string; updated_at: string };
type ImageRow = { id: string; content_id: string; file_path: string; caption: string };

export class MaterialRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(query: MaterialQuery): Material[] {
    const where: string[] = []; const args: string[] = [];
    if (query.kind) { where.push('kind = ?'); args.push(query.kind); }
    if (query.city) { where.push('location = ?'); args.push(query.city); }
    if (query.tag) { where.push('tags LIKE ?'); args.push(like(`"${query.tag}"`)); }
    if (query.text?.trim()) { where.push('(title LIKE ? OR body LIKE ? OR location LIKE ? OR tags LIKE ?)'); args.push(like(query.text), like(query.text), like(query.text), like(query.text)); }
    const rows = this.db.prepare(`SELECT * FROM content_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...args) as unknown as MaterialRow[];
    return this.attachImages(rows);
  }

  get(id: string): Material | null {
    const row = this.db.prepare('SELECT * FROM content_items WHERE id = ?').get(id) as unknown as MaterialRow | undefined;
    return row ? this.attachImages([row])[0] : null;
  }

  getMany(ids: string[]): Material[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM content_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as MaterialRow[];
    return this.attachImages(rows);
  }

  facets() {
    const rows = this.db.prepare('SELECT location, tags FROM content_items').all() as unknown as Array<{ location: string | null; tags: string }>;
    const cities = new Set<string>(); const tags = new Set<string>();
    for (const row of rows) { if (row.location) cities.add(row.location); parseList(row.tags).forEach(tag => tags.add(tag)); }
    return { cities: [...cities].sort(), tags: [...tags].sort() };
  }

  insert(input: Omit<Material, 'id' | 'images' | 'createdAt' | 'updatedAt'>): Material {
    const id = randomUUID(); const time = now();
    this.db.prepare('INSERT INTO content_items (id, kind, title, body, location, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.kind, input.title, input.body, input.city || null, json(input.tags), input.source, time, time);
    return this.get(id)!;
  }

  update(id: string, input: Pick<Material, 'kind' | 'title' | 'body' | 'city' | 'tags'>): Material | null {
    const result = this.db.prepare('UPDATE content_items SET kind = ?, title = ?, body = ?, location = ?, tags = ?, updated_at = ? WHERE id = ?')
      .run(input.kind, input.title, input.body, input.city || null, json(input.tags), now(), id);
    return result.changes ? this.get(id) : null;
  }

  delete(id: string): boolean { return this.db.prepare('DELETE FROM content_items WHERE id = ?').run(id).changes > 0; }

  addImage(materialId: string, filePath: string, caption: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO media_assets (id, content_id, file_path, caption, created_at) VALUES (?, ?, ?, ?, ?)').run(id, materialId, filePath, caption, now());
    this.touch(materialId);
    return id;
  }

  imagePath(imageId: string): string | null {
    const row = this.db.prepare('SELECT file_path FROM media_assets WHERE id = ?').get(imageId) as unknown as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  removeImage(materialId: string, imageId: string): string | null {
    const path = this.imagePath(imageId);
    this.db.prepare('DELETE FROM media_assets WHERE id = ? AND content_id = ?').run(imageId, materialId);
    this.touch(materialId);
    return path;
  }

  imagePaths(materialId: string): string[] {
    return (this.db.prepare('SELECT file_path FROM media_assets WHERE content_id = ?').all(materialId) as unknown as Array<{ file_path: string }>).map(row => row.file_path);
  }

  private touch(id: string) { this.db.prepare('UPDATE content_items SET updated_at = ? WHERE id = ?').run(now(), id); }

  private attachImages(rows: MaterialRow[]): Material[] {
    if (!rows.length) return [];
    const images = this.db.prepare(`SELECT * FROM media_assets WHERE content_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(...rows.map(row => row.id)) as unknown as ImageRow[];
    return rows.map(row => ({
      id: row.id, kind: row.kind, title: row.title, body: row.body, city: row.location ?? '', tags: parseList(row.tags), source: row.source ?? 'manual',
      images: images.filter(image => image.content_id === row.id).map((image): MaterialImage => ({ id: image.id, fileName: image.file_path.split(/[\\/]/).pop() ?? '', caption: image.caption })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
}

// ───────── 路线 ─────────
type RouteRow = { id: string; name: string; city: string; days: number; tags: string; summary: string; status: RouteStatus; created_at: string; updated_at: string };
type RouteItemRow = { id: string; route_id: string; day: number; time: string; title: string; material_id: string | null; note: string };

export class RouteRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(query: RouteQuery): Route[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (query.city) { where.push('city = ?'); args.push(query.city); }
    if (query.days) { where.push('days = ?'); args.push(query.days); }
    if (query.text?.trim()) { where.push('(name LIKE ? OR summary LIKE ? OR tags LIKE ?)'); args.push(like(query.text), like(query.text), like(query.text)); }
    const rows = this.db.prepare(`SELECT * FROM routes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...args) as unknown as RouteRow[];
    return this.withItems(rows);
  }

  get(id: string): Route | null {
    const row = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow | undefined;
    return row ? this.withItems([row])[0] : null;
  }

  recent(limit: number): Route[] {
    return this.withItems(this.db.prepare('SELECT * FROM routes ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RouteRow[]);
  }

  /** 整条路线（含行程节点）一次性保存，节点按传入顺序重排。 */
  save(route: Omit<Route, 'createdAt' | 'updatedAt'> & { createdAt?: string }): Route {
    const time = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO routes (id, name, city, days, tags, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, city=excluded.city, days=excluded.days, tags=excluded.tags, summary=excluded.summary, status=excluded.status, updated_at=excluded.updated_at`)
        .run(route.id, route.name, route.city, route.days, json(route.tags), route.summary, route.status, route.createdAt ?? time, time);
      this.db.prepare('DELETE FROM route_items WHERE route_id = ?').run(route.id);
      const insert = this.db.prepare('INSERT INTO route_items (id, route_id, day, time, title, material_id, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      route.items.forEach((item, index) => insert.run(item.id, route.id, item.day, item.time, item.title, item.materialId ?? null, item.note, index));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(route.id)!;
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM route_items WHERE route_id = ?').run(id);
    return this.db.prepare('DELETE FROM routes WHERE id = ?').run(id).changes > 0;
  }

  /** 素材被删除后，路线节点只保留文字，不再关联素材。 */
  unlinkMaterial(materialId: string) { this.db.prepare('UPDATE route_items SET material_id = NULL WHERE material_id = ?').run(materialId); }

  private withItems(rows: RouteRow[]): Route[] {
    if (!rows.length) return [];
    const items = this.db.prepare(`SELECT * FROM route_items WHERE route_id IN (${rows.map(() => '?').join(',')}) ORDER BY day ASC, sort ASC`).all(...rows.map(row => row.id)) as unknown as RouteItemRow[];
    return rows.map(row => ({
      id: row.id, name: row.name, city: row.city, days: row.days, tags: parseList(row.tags), summary: row.summary, status: row.status,
      items: items.filter(item => item.route_id === row.id).map((item): RouteItem => ({ id: item.id, day: item.day, time: item.time, title: item.title, materialId: item.material_id ?? undefined, note: item.note })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
}

// ───────── 内容 ─────────
type ContentRow = { id: string; title: string; channel: ContentChannel; body: string; status: ContentStatus; source: ContentSource; route_id: string | null; version: number; created_at: string; updated_at: string; reviewed_at: string | null; route_name?: string | null };

export class ContentRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(status?: ContentStatus): ContentPiece[] {
    const sql = `SELECT c.*, r.name AS route_name FROM contents c LEFT JOIN routes r ON r.id = c.route_id ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.updated_at DESC`;
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as unknown as ContentRow[];
    return rows.map(toContent);
  }

  get(id: string): ContentPiece | null {
    const row = this.db.prepare('SELECT c.*, r.name AS route_name FROM contents c LEFT JOIN routes r ON r.id = c.route_id WHERE c.id = ?').get(id) as unknown as ContentRow | undefined;
    return row ? toContent(row) : null;
  }

  count(status: ContentStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM contents WHERE status = ?').get(status) as unknown as { n: number }).n;
  }

  isEmpty(): boolean { return (this.db.prepare('SELECT COUNT(*) AS n FROM contents').get() as unknown as { n: number }).n === 0; }

  insert(input: { title: string; channel: ContentChannel; body: string; status: ContentStatus; source: ContentSource; routeId?: string; note: string }): ContentPiece {
    const id = randomUUID(); const time = now();
    this.db.prepare('INSERT INTO contents (id, title, channel, body, status, source, route_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.title, input.channel, input.body, input.status, input.source, input.routeId ?? null, time, time);
    this.addVersion(id, 1, input.body, input.note);
    return this.get(id)!;
  }

  /** 正文变化时自动记一个新版本。 */
  update(id: string, patch: { title?: string; channel?: ContentChannel; body?: string; status?: ContentStatus; source?: ContentSource; routeId?: string | null; reviewedAt?: string | null }, note = ''): ContentPiece | null {
    const current = this.get(id);
    if (!current) return null;
    const bodyChanged = patch.body !== undefined && patch.body !== current.body;
    const version = bodyChanged ? current.version + 1 : current.version;
    this.db.prepare('UPDATE contents SET title = ?, channel = ?, body = ?, status = ?, source = ?, route_id = ?, version = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(
      patch.title ?? current.title, patch.channel ?? current.channel, patch.body ?? current.body, patch.status ?? current.status, patch.source ?? current.source,
      patch.routeId === undefined ? current.routeId ?? null : patch.routeId, version, patch.reviewedAt === undefined ? current.reviewedAt ?? null : patch.reviewedAt, now(), id,
    );
    if (bodyChanged) this.addVersion(id, version, patch.body!, note);
    return this.get(id);
  }

  versions(id: string): ContentVersion[] {
    const rows = this.db.prepare('SELECT * FROM content_versions WHERE content_id = ? ORDER BY version DESC').all(id) as unknown as Array<{ version: number; body: string; note: string; created_at: string }>;
    return rows.map(row => ({ version: row.version, body: row.body, note: row.note, createdAt: row.created_at }));
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM content_versions WHERE content_id = ?').run(id);
    return this.db.prepare('DELETE FROM contents WHERE id = ?').run(id).changes > 0;
  }

  private addVersion(id: string, version: number, body: string, note: string) {
    this.db.prepare('INSERT OR REPLACE INTO content_versions (content_id, version, body, note, created_at) VALUES (?, ?, ?, ?, ?)').run(id, version, body, note, now());
  }
}

function toContent(row: ContentRow): ContentPiece {
  return { id: row.id, title: row.title, channel: row.channel, body: row.body, status: row.status, source: row.source, routeId: row.route_id ?? undefined, routeName: row.route_name ?? undefined, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, reviewedAt: row.reviewed_at ?? undefined };
}

// ───────── 群 ─────────
type GroupRow = { id: string; chat_id: string; name: string; channel: GroupChannel; owner: string; member_count: number; enabled: number; match_mode: GroupMatchMode; available: number; last_sent_at: string | null; updated_at: string };

export class GroupRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Array<Omit<OpsGroup, 'todaySent'>> {
    return (this.db.prepare('SELECT * FROM ops_groups ORDER BY channel ASC, name ASC').all() as unknown as GroupRow[]).map(toGroup);
  }

  get(id: string): Omit<OpsGroup, 'todaySent'> | null {
    const row = this.db.prepare('SELECT * FROM ops_groups WHERE id = ?').get(id) as unknown as GroupRow | undefined;
    return row ? toGroup(row) : null;
  }

  upsert(group: Omit<OpsGroup, 'todaySent' | 'updatedAt'>) {
    this.db.prepare(`INSERT INTO ops_groups (id, chat_id, name, channel, owner, member_count, enabled, match_mode, available, last_sent_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, name=excluded.name, owner=excluded.owner, member_count=excluded.member_count, enabled=excluded.enabled,
      match_mode=excluded.match_mode, available=excluded.available, last_sent_at=excluded.last_sent_at, updated_at=excluded.updated_at`)
      .run(group.id, group.chatId, group.name, group.channel, group.owner, group.memberCount, group.enabled ? 1 : 0, group.matchMode, group.available ? 1 : 0, group.lastSentAt ?? null, now());
  }

  markSent(id: string, time: string) { this.db.prepare('UPDATE ops_groups SET last_sent_at = ? WHERE id = ?').run(time, id); }
}

function toGroup(row: GroupRow): Omit<OpsGroup, 'todaySent'> {
  return { id: row.id, chatId: row.chat_id, name: row.name, channel: row.channel, owner: row.owner, memberCount: row.member_count, enabled: row.enabled === 1, matchMode: row.match_mode, available: row.available === 1, lastSentAt: row.last_sent_at ?? undefined, updatedAt: row.updated_at };
}

// ───────── 任务 ─────────
type TaskRow = { id: string; content_id: string; group_ids: string; run_at: string; repeat: TaskRepeat; weather_city: string; status: TaskStatus; next_run_at: string | null; last_run_at: string | null; last_result: string | null; attempts: number; retry_group_ids: string; created_at: string };
/** retryGroupIds：本轮发送失败、重试时只补发这些群，避免重复发给已成功的群。 */
export type StoredTask = Omit<OpsTask, 'contentTitle' | 'groupNames'> & { retryGroupIds: string[] };

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(status?: TaskStatus): StoredTask[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM ops_tasks WHERE status = ? ORDER BY COALESCE(next_run_at, last_run_at, run_at) DESC').all(status)
      : this.db.prepare('SELECT * FROM ops_tasks ORDER BY COALESCE(next_run_at, last_run_at, run_at) DESC').all()) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  get(id: string): StoredTask | null {
    const row = this.db.prepare('SELECT * FROM ops_tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  due(at: string): StoredTask[] {
    return (this.db.prepare("SELECT * FROM ops_tasks WHERE status = 'pending' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC").all(at) as unknown as TaskRow[]).map(toTask);
  }

  byContent(contentId: string): StoredTask[] {
    return (this.db.prepare('SELECT * FROM ops_tasks WHERE content_id = ?').all(contentId) as unknown as TaskRow[]).map(toTask);
  }

  save(task: StoredTask) {
    this.db.prepare(`INSERT INTO ops_tasks (id, content_id, group_ids, run_at, repeat, weather_city, status, next_run_at, last_run_at, last_result, attempts, retry_group_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content_id=excluded.content_id, group_ids=excluded.group_ids, run_at=excluded.run_at, repeat=excluded.repeat, weather_city=excluded.weather_city,
      status=excluded.status, next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at, last_result=excluded.last_result, attempts=excluded.attempts, retry_group_ids=excluded.retry_group_ids`)
      .run(task.id, task.contentId, json(task.groupIds), task.runAt, task.repeat, task.weatherCity, task.status, task.nextRunAt ?? null, task.lastRunAt ?? null, task.lastResult ?? null, task.attempts, json(task.retryGroupIds), task.createdAt);
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
    return this.db.prepare('DELETE FROM ops_tasks WHERE id = ?').run(id).changes > 0;
  }

  /** 程序异常退出时可能残留“执行中”的任务，启动时放回待执行。 */
  resetRunning() { this.db.prepare("UPDATE ops_tasks SET status = 'pending' WHERE status = 'running'").run(); }

  addRun(run: Omit<TaskRun, 'id'>) {
    this.db.prepare('INSERT INTO task_runs (id, task_id, started_at, status, detail) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), run.taskId, run.startedAt, run.status, run.detail);
  }

  runs(taskId: string): TaskRun[] {
    const rows = this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50').all(taskId) as unknown as Array<{ id: string; task_id: string; started_at: string; status: TaskRun['status']; detail: string }>;
    return rows.map(row => ({ id: row.id, taskId: row.task_id, startedAt: row.started_at, status: row.status, detail: row.detail }));
  }

  runsBetween(from: string, to: string): TaskRun[] {
    const rows = this.db.prepare('SELECT * FROM task_runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at ASC').all(from, to) as unknown as Array<{ id: string; task_id: string; started_at: string; status: TaskRun['status']; detail: string }>;
    return rows.map(row => ({ id: row.id, taskId: row.task_id, startedAt: row.started_at, status: row.status, detail: row.detail }));
  }
}

function toTask(row: TaskRow): StoredTask {
  return { id: row.id, contentId: row.content_id, groupIds: parseList(row.group_ids), runAt: row.run_at, repeat: row.repeat, weatherCity: row.weather_city, status: row.status, nextRunAt: row.next_run_at ?? undefined, lastRunAt: row.last_run_at ?? undefined, lastResult: row.last_result ?? undefined, attempts: row.attempts, retryGroupIds: parseList(row.retry_group_ids), createdAt: row.created_at };
}

// ───────── 日志 ─────────
type LogRow = { id: string; time: string; module: LogEntry['module']; action: string; status: LogEntry['status']; message: string; task_id: string | null; group_name: string | null; attempt: number | null; detail: string | null };

export class LogRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(entry: Omit<LogEntry, 'id' | 'time'> & { time?: string }) {
    this.db.prepare('INSERT INTO ops_logs (id, time, module, action, status, message, task_id, group_name, attempt, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entry.time ?? now(), entry.module, entry.action, entry.status, entry.message, entry.taskId ?? null, entry.groupName ?? null, entry.attempt ?? null, entry.detail ?? null);
  }

  list(query: LogQuery): LogEntry[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (query.status) { where.push('status = ?'); args.push(query.status); }
    if (query.module) { where.push('module = ?'); args.push(query.module); }
    if (query.taskId) { where.push('task_id = ?'); args.push(query.taskId); }
    args.push(Math.min(Math.max(query.limit ?? 300, 1), 1000));
    const rows = this.db.prepare(`SELECT * FROM ops_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY time DESC LIMIT ?`).all(...args) as unknown as LogRow[];
    return rows.map(row => ({ id: row.id, time: row.time, module: row.module, action: row.action, status: row.status, message: row.message, taskId: row.task_id ?? undefined, groupName: row.group_name ?? undefined, attempt: row.attempt ?? undefined, detail: row.detail ?? undefined }));
  }

  countSentSince(groupName: string, since: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ops_logs WHERE module = 'WeCom' AND status = 'ok' AND group_name = ? AND time >= ?").get(groupName, since) as unknown as { n: number }).n;
  }

  prune(before: string) { this.db.prepare('DELETE FROM ops_logs WHERE time < ?').run(before); }
}
