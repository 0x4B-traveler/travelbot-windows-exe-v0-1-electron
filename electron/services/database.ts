import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentItem, ContentKind, WeatherJobSettings } from '../../src/domain/business';

type ContentRow = {
  id: string;
  kind: ContentKind;
  title: string;
  body: string;
  location: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
};
type WeatherJobRow = { id: string; location: string; chat_ids: string; interval_minutes: number; enabled: number; last_sent_at: string | null; last_result: string | null };

export class TravelDatabase {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        location TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_content_title ON content_items(title);
      CREATE INDEX IF NOT EXISTS idx_content_kind ON content_items(kind);

      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        caption TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weather_jobs (
        id TEXT PRIMARY KEY,
        location TEXT NOT NULL,
        chat_ids TEXT NOT NULL DEFAULT '[]',
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT,
        last_result TEXT
      );
    `);
  }

  close() { this.db.close(); }

  searchContent(query: string, kind?: ContentKind): ContentItem[] {
    const normalized = `%${query.trim()}%`;
    const statement = kind
      ? this.db.prepare('SELECT * FROM content_items WHERE kind = ? AND (title LIKE ? OR body LIKE ? OR location LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC')
      : this.db.prepare('SELECT * FROM content_items WHERE title LIKE ? OR body LIKE ? OR location LIKE ? OR tags LIKE ? ORDER BY updated_at DESC');
    const rows = (kind
      ? statement.all(kind, normalized, normalized, normalized, normalized)
      : statement.all(normalized, normalized, normalized, normalized)) as unknown as ContentRow[];
    return rows.map(toContentItem);
  }

  createContent(input: { kind: ContentKind; title: string; body: string; location?: string; tags?: string[] }): ContentItem {
    const now = new Date().toISOString();
    const item: ContentItem = { id: randomUUID(), kind: input.kind, title: input.title.trim(), body: input.body.trim(), location: input.location, tags: input.tags ?? [], createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO content_items (id, kind, title, body, location, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(item.id, item.kind, item.title, item.body, item.location ?? null, JSON.stringify(item.tags), item.createdAt, item.updatedAt);
    return item;
  }

  updateContent(id: string, patch: Partial<Pick<ContentItem, 'title' | 'body' | 'location' | 'tags'>>): ContentItem | null {
    const current = this.getContent(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE content_items SET title = ?, body = ?, location = ?, tags = ?, updated_at = ? WHERE id = ?').run(next.title, next.body, next.location ?? null, JSON.stringify(next.tags), next.updatedAt, id);
    return next;
  }

  deleteContent(id: string): boolean {
    return this.db.prepare('DELETE FROM content_items WHERE id = ?').run(id).changes > 0;
  }

  getContent(id: string): ContentItem | null {
    const row = this.db.prepare('SELECT * FROM content_items WHERE id = ?').get(id) as unknown as ContentRow | undefined;
    return row ? toContentItem(row) : null;
  }

  /** 按创建顺序列出全部内容，用于每日推荐轮换（编辑内容不会打乱顺序）。 */
  listContentForRotation(): ContentItem[] {
    const rows = this.db.prepare('SELECT * FROM content_items ORDER BY created_at ASC, id ASC').all() as unknown as ContentRow[];
    return rows.map(toContentItem);
  }

  getWeatherJob(): WeatherJobSettings {
    const row = this.db.prepare('SELECT * FROM weather_jobs WHERE id = ?').get('default') as unknown as WeatherJobRow | undefined;
    if (!row) return { id: 'default', location: '', chatIds: [], intervalMinutes: 60, enabled: false };
    return { id: row.id, location: row.location, chatIds: parseJsonArray(row.chat_ids), intervalMinutes: row.interval_minutes, enabled: row.enabled === 1, lastSentAt: row.last_sent_at ?? undefined, lastResult: row.last_result ?? undefined };
  }

  saveWeatherJob(input: Omit<WeatherJobSettings, 'id'> & { id?: string }): WeatherJobSettings {
    const job: WeatherJobSettings = { id: input.id ?? 'default', location: input.location.trim(), chatIds: input.chatIds, intervalMinutes: Math.max(1, Math.round(input.intervalMinutes || 60)), enabled: input.enabled, lastSentAt: input.lastSentAt, lastResult: input.lastResult };
    this.db.prepare(`INSERT INTO weather_jobs (id, location, chat_ids, interval_minutes, enabled, last_sent_at, last_result) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET location=excluded.location, chat_ids=excluded.chat_ids, interval_minutes=excluded.interval_minutes, enabled=excluded.enabled, last_sent_at=excluded.last_sent_at, last_result=excluded.last_result`).run(job.id, job.location, JSON.stringify(job.chatIds), job.intervalMinutes, job.enabled ? 1 : 0, job.lastSentAt ?? null, job.lastResult ?? null);
    return job;
  }
}

function toContentItem(row: ContentRow): ContentItem {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags) as string[]; } catch { /* keep empty */ }
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, location: row.location ?? undefined, tags, createdAt: row.created_at, updatedAt: row.updated_at };
}

function parseJsonArray(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; }
}
