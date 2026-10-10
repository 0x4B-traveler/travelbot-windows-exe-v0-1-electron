import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEMPLATES, DEFAULT_WEATHER_RULES, TEMPLATE_KEYS,
  type BatchKind, type BatchStatus, type GroupChannel, type GroupMatchMode, type LogEntry, type LogQuery, type Material, type MaterialImage, type MaterialKind,
  type MaterialQuery, type MaterialSource, type MessageTemplate, type OpsGroup, type PlanMessage, type PlanMessageStatus, type Route, type RouteDay, type RouteQuery,
  type RouteStatus, type TemplateKey, type Tour, type TourState, type WeatherRule, type WeatherRuleKind,
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
    CREATE TABLE IF NOT EXISTS route_days (
      route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE, day INTEGER NOT NULL, city TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '', hotel_id TEXT, spot_ids TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (route_id, day)
    );
    CREATE TABLE IF NOT EXISTS ops_groups (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, channel TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
      member_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, match_mode TEXT NOT NULL DEFAULT 'id',
      available INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tour_templates (key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weather_rules (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', essentials TEXT NOT NULL DEFAULT '', clothing TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS send_batches (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, day_no INTEGER, status TEXT NOT NULL,
      not_before TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_send_batches_date ON send_batches(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_send_batches_evening ON send_batches(group_id, date) WHERE kind = 'evening';
    CREATE TABLE IF NOT EXISTS send_messages (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES send_batches(id) ON DELETE CASCADE, seq INTEGER NOT NULL, label TEXT NOT NULL,
      text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, sent_at TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS ops_logs (
      id TEXT PRIMARY KEY, time TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
      task_id TEXT, group_name TEXT, attempt INTEGER, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ops_logs_time ON ops_logs(time);
  `);
  // 素材表来自旧版本，补上“来源”列
  const columns = db.prepare('PRAGMA table_info(content_items)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'source')) db.exec("ALTER TABLE content_items ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  const addColumn = (table: string, column: string, ddl: string) => {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!existing.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  // RPA 账号池：群绑定发送账号，日志记录是哪个账号发的（防封限频按账号计算）
  addColumn('ops_groups', 'account_id', 'account_id TEXT');
  addColumn('ops_logs', 'account', 'account TEXT');
  // 一组消息共用一个 batch_id，防封计数时一组算一次
  addColumn('ops_logs', 'batch_id', 'batch_id TEXT');
  // 一个群对应一个团：路线、出发日期、暂停/取消、按天换的酒店
  addColumn('ops_groups', 'route_id', 'route_id TEXT');
  addColumn('ops_groups', 'start_date', 'start_date TEXT');
  addColumn('ops_groups', 'tour_state', "tour_state TEXT NOT NULL DEFAULT 'normal'");
  addColumn('ops_groups', 'hotel_overrides', "hotel_overrides TEXT NOT NULL DEFAULT '{}'");
  addColumn('ops_groups', 'tour_note', "tour_note TEXT NOT NULL DEFAULT ''");
  migrateRouteItems(db);
  // 默认天气对照表（只在第一次时写入，之后客户自己改）
  const rules = db.prepare('SELECT COUNT(*) AS n FROM weather_rules').get() as unknown as { n: number };
  if (rules.n === 0 && !db.prepare("SELECT 1 FROM tour_templates WHERE key = '__rules_seeded'").get()) {
    const insert = db.prepare('INSERT INTO weather_rules (id, kind, value, essentials, clothing, sort) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_WEATHER_RULES.forEach((rule, index) => insert.run(randomUUID(), rule.kind, rule.value, rule.essentials, rule.clothing, index));
    db.prepare("INSERT OR REPLACE INTO tour_templates (key, body, updated_at) VALUES ('__rules_seeded', '', ?)").run(new Date().toISOString());
  }
  db.exec('PRAGMA foreign_keys = ON;');
}

/** 旧版路线是“行程节点”（时间 + 标题 + 关联素材），转成按天一行：行程用节点标题拼起来，酒店、景点从关联素材里取。 */
function migrateRouteItems(db: DatabaseSync) {
  const routes = db.prepare('SELECT r.id, r.city, r.days FROM routes r WHERE NOT EXISTS (SELECT 1 FROM route_days d WHERE d.route_id = r.id)').all() as unknown as Array<{ id: string; city: string; days: number }>;
  if (!routes.length) return;
  const items = db.prepare(`SELECT i.day, i.title, i.material_id, m.kind, m.location FROM route_items i LEFT JOIN content_items m ON m.id = i.material_id WHERE i.route_id = ? ORDER BY i.day, i.sort`);
  const insert = db.prepare('INSERT INTO route_days (route_id, day, city, plan, hotel_id, spot_ids) VALUES (?, ?, ?, ?, ?, ?)');
  for (const route of routes) {
    const rows = items.all(route.id) as unknown as Array<{ day: number; title: string; material_id: string | null; kind: string | null; location: string | null }>;
    for (let day = 1; day <= Math.max(1, route.days); day += 1) {
      const today = rows.filter(row => row.day === day);
      const city = today.find(row => row.location && row.kind !== 'route')?.location ?? route.city ?? '';
      const hotel = today.find(row => row.kind === 'hotel')?.material_id ?? null;
      const spots = today.filter(row => row.kind === 'spot' || row.kind === 'guide').map(row => row.material_id!);
      insert.run(route.id, day, city, today.map(row => row.title).join('、'), hotel, json(spots));
    }
  }
}

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
function parseList(value: string | null | undefined): string[] {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; }
}
function parseMap(value: string | null | undefined): Record<string, string> {
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === 'string')) as Record<string, string> : {}; } catch { return {}; }
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
type RouteDayRow = { route_id: string; day: number; city: string; plan: string; hotel_id: string | null; spot_ids: string };

export class RouteRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(query: RouteQuery): Route[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (query.city) { where.push('(city = ? OR id IN (SELECT route_id FROM route_days WHERE city = ?))'); args.push(query.city, query.city); }
    if (query.days) { where.push('days = ?'); args.push(query.days); }
    if (query.text?.trim()) { where.push('(name LIKE ? OR summary LIKE ? OR tags LIKE ?)'); args.push(like(query.text), like(query.text), like(query.text)); }
    const rows = this.db.prepare(`SELECT * FROM routes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...args) as unknown as RouteRow[];
    return this.withDays(rows);
  }

  get(id: string): Route | null {
    const row = this.db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow | undefined;
    return row ? this.withDays([row])[0] : null;
  }

  /** 整条路线（含每天的日程）一次性保存。 */
  save(route: Omit<Route, 'createdAt' | 'updatedAt'> & { createdAt?: string }): Route {
    const time = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO routes (id, name, city, days, tags, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, city=excluded.city, days=excluded.days, tags=excluded.tags, summary=excluded.summary, status=excluded.status, updated_at=excluded.updated_at`)
        .run(route.id, route.name, route.city, route.days, json(route.tags), route.summary, route.status, route.createdAt ?? time, time);
      this.db.prepare('DELETE FROM route_days WHERE route_id = ?').run(route.id);
      const insert = this.db.prepare('INSERT INTO route_days (route_id, day, city, plan, hotel_id, spot_ids) VALUES (?, ?, ?, ?, ?, ?)');
      route.dayPlans.forEach(day => insert.run(route.id, day.day, day.city, day.plan, day.hotelId ?? null, json(day.spotIds)));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(route.id)!;
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM route_days WHERE route_id = ?').run(id);
    this.db.prepare('DELETE FROM route_items WHERE route_id = ?').run(id);
    return this.db.prepare('DELETE FROM routes WHERE id = ?').run(id).changes > 0;
  }

  /** 素材被删除后，路线里不再引用它。 */
  unlinkMaterial(materialId: string) {
    this.db.prepare('UPDATE route_days SET hotel_id = NULL WHERE hotel_id = ?').run(materialId);
    const rows = this.db.prepare('SELECT route_id, day, spot_ids FROM route_days WHERE spot_ids LIKE ?').all(like(`"${materialId}"`)) as unknown as RouteDayRow[];
    const update = this.db.prepare('UPDATE route_days SET spot_ids = ? WHERE route_id = ? AND day = ?');
    rows.forEach(row => update.run(json(parseList(row.spot_ids).filter(id => id !== materialId)), row.route_id, row.day));
    this.db.prepare('UPDATE route_items SET material_id = NULL WHERE material_id = ?').run(materialId);
  }

  private withDays(rows: RouteRow[]): Route[] {
    if (!rows.length) return [];
    const days = this.db.prepare(`SELECT * FROM route_days WHERE route_id IN (${rows.map(() => '?').join(',')}) ORDER BY day ASC`).all(...rows.map(row => row.id)) as unknown as RouteDayRow[];
    return rows.map(row => ({
      id: row.id, name: row.name, city: row.city, days: row.days, tags: parseList(row.tags), summary: row.summary, status: row.status,
      dayPlans: days.filter(day => day.route_id === row.id).map((day): RouteDay => ({ day: day.day, city: day.city, plan: day.plan, hotelId: day.hotel_id ?? undefined, spotIds: parseList(day.spot_ids) })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
}

// ───────── 群（含团） ─────────
type GroupRow = {
  id: string; chat_id: string; name: string; channel: GroupChannel; owner: string; member_count: number; enabled: number; match_mode: GroupMatchMode; available: number;
  last_sent_at: string | null; account_id: string | null; route_id: string | null; start_date: string | null; tour_state: TourState | null; hotel_overrides: string | null; tour_note: string | null; updated_at: string;
};
export type StoredGroup = Omit<OpsGroup, 'todaySent' | 'routeName' | 'tourDays' | 'endDate' | 'phase' | 'dayNo'>;

export class GroupRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): StoredGroup[] {
    return (this.db.prepare('SELECT * FROM ops_groups ORDER BY COALESCE(start_date, \'9999\') DESC, name ASC').all() as unknown as GroupRow[]).map(toGroup);
  }

  get(id: string): StoredGroup | null {
    const row = this.db.prepare('SELECT * FROM ops_groups WHERE id = ?').get(id) as unknown as GroupRow | undefined;
    return row ? toGroup(row) : null;
  }

  byRoute(routeId: string): StoredGroup[] {
    return (this.db.prepare('SELECT * FROM ops_groups WHERE route_id = ?').all(routeId) as unknown as GroupRow[]).map(toGroup);
  }

  upsert(group: Omit<StoredGroup, 'updatedAt'>) {
    const tour = group.tour;
    this.db.prepare(`INSERT INTO ops_groups (id, chat_id, name, channel, owner, member_count, enabled, match_mode, available, last_sent_at, account_id, route_id, start_date, tour_state, hotel_overrides, tour_note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, name=excluded.name, owner=excluded.owner, member_count=excluded.member_count, enabled=excluded.enabled,
      match_mode=excluded.match_mode, available=excluded.available, last_sent_at=excluded.last_sent_at, account_id=excluded.account_id, route_id=excluded.route_id,
      start_date=excluded.start_date, tour_state=excluded.tour_state, hotel_overrides=excluded.hotel_overrides, tour_note=excluded.tour_note, updated_at=excluded.updated_at`)
      .run(group.id, group.chatId, group.name, group.channel, group.owner, group.memberCount, group.enabled ? 1 : 0, group.matchMode, group.available ? 1 : 0, group.lastSentAt ?? null, group.accountId ?? null,
        tour?.routeId ?? null, tour?.startDate ?? null, tour?.state ?? 'normal', json(tour?.hotelOverrides ?? {}), tour?.note ?? '', now());
  }

  markSent(id: string, time: string) { this.db.prepare('UPDATE ops_groups SET last_sent_at = ? WHERE id = ?').run(time, id); }

  delete(id: string) { this.db.prepare('DELETE FROM ops_groups WHERE id = ?').run(id); }
}

function toGroup(row: GroupRow): StoredGroup {
  const tour: Tour | undefined = row.route_id && row.start_date
    ? { routeId: row.route_id, startDate: row.start_date, state: row.tour_state ?? 'normal', hotelOverrides: parseMap(row.hotel_overrides), note: row.tour_note ?? '' }
    : undefined;
  return { id: row.id, chatId: row.chat_id, name: row.name, channel: row.channel, owner: row.owner, memberCount: row.member_count, enabled: row.enabled === 1, matchMode: row.match_mode, available: row.available === 1, lastSentAt: row.last_sent_at ?? undefined, accountId: row.account_id ?? undefined, tour, updatedAt: row.updated_at };
}

// ───────── 模板、天气对照表 ─────────
export class TemplateRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): MessageTemplate[] {
    const rows = this.db.prepare('SELECT * FROM tour_templates').all() as unknown as Array<{ key: string; body: string; updated_at: string }>;
    const byKey = new Map(rows.map(row => [row.key, row]));
    return TEMPLATE_KEYS.map(key => {
      const row = byKey.get(key);
      return row ? { key, body: row.body, isDefault: row.body === DEFAULT_TEMPLATES[key], updatedAt: row.updated_at } : { key, body: DEFAULT_TEMPLATES[key], isDefault: true };
    });
  }

  get(key: TemplateKey): string { return this.list().find(item => item.key === key)!.body; }

  save(key: TemplateKey, body: string) { this.db.prepare('INSERT OR REPLACE INTO tour_templates (key, body, updated_at) VALUES (?, ?, ?)').run(key, body, now()); }

  reset(key: TemplateKey) { this.db.prepare('DELETE FROM tour_templates WHERE key = ?').run(key); }
}

export class WeatherRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): WeatherRule[] {
    const rows = this.db.prepare('SELECT * FROM weather_rules ORDER BY sort ASC').all() as unknown as Array<{ id: string; kind: WeatherRuleKind; value: string; essentials: string; clothing: string }>;
    return rows.map(row => ({ id: row.id, kind: row.kind, value: row.value, essentials: row.essentials, clothing: row.clothing }));
  }

  replaceAll(rules: WeatherRule[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM weather_rules').run();
      const insert = this.db.prepare('INSERT INTO weather_rules (id, kind, value, essentials, clothing, sort) VALUES (?, ?, ?, ?, ?, ?)');
      rules.forEach((rule, index) => insert.run(rule.id, rule.kind, rule.value, rule.essentials, rule.clothing, index));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

// ───────── 发送计划（一组 + 每条消息） ─────────
type BatchRow = { id: string; group_id: string; kind: BatchKind; date: string; day_no: number | null; status: BatchStatus; not_before: string | null; attempts: number; last_result: string | null; created_at: string; updated_at: string };
type MessageRow = { id: string; batch_id: string; seq: number; label: string; text: string; images: string; status: PlanMessageStatus; sent_at: string | null; error: string | null };
export type StoredMessage = PlanMessage & { id: string };
export type StoredBatch = { id: string; groupId: string; kind: BatchKind; date: string; dayNo?: number; status: BatchStatus; notBefore?: string; attempts: number; lastResult?: string; updatedAt: string; messages: StoredMessage[] };

export class BatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): StoredBatch | null {
    const row = this.db.prepare('SELECT * FROM send_batches WHERE id = ?').get(id) as unknown as BatchRow | undefined;
    return row ? this.withMessages([row])[0] : null;
  }

  evening(groupId: string, date: string): StoredBatch | null {
    const row = this.db.prepare("SELECT * FROM send_batches WHERE group_id = ? AND date = ? AND kind = 'evening'").get(groupId, date) as unknown as BatchRow | undefined;
    return row ? this.withMessages([row])[0] : null;
  }

  between(from: string, to: string, groupId?: string): StoredBatch[] {
    const rows = (groupId
      ? this.db.prepare('SELECT * FROM send_batches WHERE date >= ? AND date <= ? AND group_id = ? ORDER BY date ASC, created_at ASC').all(from, to, groupId)
      : this.db.prepare('SELECT * FROM send_batches WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC').all(from, to)) as unknown as BatchRow[];
    return this.withMessages(rows);
  }

  /** 还没发完、日期已经过去的组。 */
  stale(today: string): StoredBatch[] {
    return this.withMessages(this.db.prepare("SELECT * FROM send_batches WHERE date < ? AND status IN ('planned', 'sending')").all(today) as unknown as BatchRow[]);
  }

  create(batch: Omit<StoredBatch, 'id' | 'updatedAt' | 'messages'> & { messages: PlanMessage[] }): StoredBatch {
    const id = randomUUID(); const time = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO send_batches (id, group_id, kind, date, day_no, status, not_before, attempts, last_result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, batch.groupId, batch.kind, batch.date, batch.dayNo ?? null, batch.status, batch.notBefore ?? null, batch.attempts, batch.lastResult ?? null, time, time);
      this.insertMessages(id, batch.messages);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id)!;
  }

  /** notBefore / lastResult 传 null 表示清空。 */
  update(id: string, patch: { status?: BatchStatus; notBefore?: string | null; attempts?: number; lastResult?: string | null; dayNo?: number }) {
    const current = this.get(id);
    if (!current) return;
    this.db.prepare('UPDATE send_batches SET status = ?, not_before = ?, attempts = ?, last_result = ?, day_no = ?, updated_at = ? WHERE id = ?').run(
      patch.status ?? current.status, (patch.notBefore === undefined ? current.notBefore : patch.notBefore) ?? null, patch.attempts ?? current.attempts,
      (patch.lastResult === undefined ? current.lastResult : patch.lastResult) ?? null, (patch.dayNo === undefined ? current.dayNo : patch.dayNo) ?? null, now(), id);
  }

  /** 开始发之前（第一次）写入这组要发的消息。 */
  setMessages(id: string, messages: PlanMessage[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM send_messages WHERE batch_id = ?').run(id);
      this.insertMessages(id, messages);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markMessage(id: string, status: PlanMessageStatus, error?: string) {
    this.db.prepare('UPDATE send_messages SET status = ?, sent_at = ?, error = ? WHERE id = ?').run(status, status === 'sent' ? now() : null, error ?? null, id);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM send_messages WHERE batch_id = ?').run(id);
    this.db.prepare('DELETE FROM send_batches WHERE id = ?').run(id);
  }

  deleteByGroup(groupId: string) {
    this.db.prepare('DELETE FROM send_messages WHERE batch_id IN (SELECT id FROM send_batches WHERE group_id = ?)').run(groupId);
    this.db.prepare('DELETE FROM send_batches WHERE group_id = ?').run(groupId);
  }

  /** 程序异常退出时可能残留“发送中”，启动时放回待发送（已发出的消息有记录，不会重发）。 */
  resetSending() { this.db.prepare("UPDATE send_batches SET status = 'planned' WHERE status = 'sending'").run(); }

  private insertMessages(batchId: string, messages: PlanMessage[]) {
    const insert = this.db.prepare('INSERT INTO send_messages (id, batch_id, seq, label, text, images, status, sent_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    messages.forEach((message, index) => insert.run(randomUUID(), batchId, index, message.label, message.text, json(message.images), message.status, message.sentAt ?? null, message.error ?? null));
  }

  private withMessages(rows: BatchRow[]): StoredBatch[] {
    if (!rows.length) return [];
    const messages = this.db.prepare(`SELECT * FROM send_messages WHERE batch_id IN (${rows.map(() => '?').join(',')}) ORDER BY seq ASC`).all(...rows.map(row => row.id)) as unknown as MessageRow[];
    return rows.map(row => ({
      id: row.id, groupId: row.group_id, kind: row.kind, date: row.date, dayNo: row.day_no ?? undefined, status: row.status, notBefore: row.not_before ?? undefined,
      attempts: row.attempts, lastResult: row.last_result ?? undefined, updatedAt: row.updated_at,
      messages: messages.filter(message => message.batch_id === row.id).map(message => {
        const images = parseList(message.images);
        return { id: message.id, label: message.label, text: message.text, images, imageCount: images.length, status: message.status, sentAt: message.sent_at ?? undefined, error: message.error ?? undefined };
      }),
    }));
  }
}

// ───────── 日志 ─────────
type LogRow = { id: string; time: string; module: LogEntry['module']; action: string; status: LogEntry['status']; message: string; task_id: string | null; group_name: string | null; attempt: number | null; account: string | null; batch_id: string | null; detail: string | null };
const toLog = (row: LogRow): LogEntry => ({ id: row.id, time: row.time, module: row.module, action: row.action, status: row.status, message: row.message, taskId: row.task_id ?? undefined, groupName: row.group_name ?? undefined, attempt: row.attempt ?? undefined, account: row.account ?? undefined, batchId: row.batch_id ?? undefined, detail: row.detail ?? undefined });

export class LogRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(entry: Omit<LogEntry, 'id' | 'time'> & { time?: string }) {
    this.db.prepare('INSERT INTO ops_logs (id, time, module, action, status, message, task_id, group_name, attempt, account, batch_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entry.time ?? now(), entry.module, entry.action, entry.status, entry.message, entry.taskId ?? null, entry.groupName ?? null, entry.attempt ?? null, entry.account ?? null, entry.batchId ?? null, entry.detail ?? null);
  }

  list(query: LogQuery): LogEntry[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (query.status) { where.push('status = ?'); args.push(query.status); }
    if (query.module) { where.push('module = ?'); args.push(query.module); }
    if (query.taskId) { where.push('(task_id = ? OR batch_id = ?)'); args.push(query.taskId, query.taskId); }
    args.push(Math.min(Math.max(query.limit ?? 300, 1), 1000));
    const rows = this.db.prepare(`SELECT * FROM ops_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY time DESC LIMIT ?`).all(...args) as unknown as LogRow[];
    return rows.map(toLog);
  }

  /** 某个群今天发了几次（一组消息算一次）。 */
  countSentSince(groupName: string, since: string): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT COALESCE(batch_id, id)) AS n FROM ops_logs WHERE module = 'RPA' AND status = 'ok' AND group_name = ? AND time >= ?").get(groupName, since) as unknown as { n: number }).n;
  }

  /** 某个 RPA 账号成功发送的次数，防封限频用：同一组消息（batch_id 相同）只算一次。 */
  countRpaSentSince(account: string, since: string, groupName?: string): number {
    const sql = `SELECT COUNT(DISTINCT COALESCE(batch_id, id)) AS n FROM ops_logs WHERE module = 'RPA' AND status = 'ok' AND account = ? AND group_name IS NOT NULL AND time >= ?${groupName ? ' AND group_name = ?' : ''}`;
    return (this.db.prepare(sql).get(...(groupName ? [account, since, groupName] : [account, since])) as unknown as { n: number }).n;
  }

  /** 这一组是否已经在这个账号上发出过至少一条（发过就不再占新的次数）。 */
  batchStarted(account: string, batchId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ops_logs WHERE module = 'RPA' AND status = 'ok' AND account = ? AND batch_id = ? LIMIT 1").get(account, batchId));
  }

  prune(before: string) { this.db.prepare('DELETE FROM ops_logs WHERE time < ?').run(before); }
}
