import { DatabaseSync, type DatabaseSync as Database } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BackupResult } from '../../src/domain/ops';

// 数据备份：把 SQLite 数据库（路线、素材、群和团、模板、发送记录）和素材图片打包成一个文件。
// 恢复时先把备份放到待恢复目录，程序重启、打开数据库之前替换，避免替换正在使用的数据库文件。

const FORMAT = 'travelbot-rpa-backup';
type BackupFile = { format: string; version: 1; createdAt: string; database: string; files: Array<{ name: string; data: string }> };

const PENDING_DB = 'restore-pending.sqlite';
const PENDING_FILES = 'restore-pending-files';

export class BackupStore {
  constructor(private readonly db: Database, private readonly userData: string, private readonly filesDir: string) {}

  /** 导出到 target，返回导出了多少东西。 */
  export(target: string): BackupResult {
    const temp = join(this.userData, `backup-${Date.now()}.sqlite`);
    try {
      this.db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
      const paths = (this.db.prepare('SELECT file_path FROM media_assets').all() as unknown as Array<{ file_path: string }>).map(row => row.file_path);
      const files = [...new Set(paths)].filter(path => existsSync(path)).map(path => ({ name: basename(path), data: readFileSync(path).toString('base64') }));
      const count = (sql: string) => (this.db.prepare(sql).get() as unknown as { n: number }).n;
      const backup: BackupFile = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), database: readFileSync(temp).toString('base64'), files };
      writeFileSync(target, JSON.stringify(backup));
      return { path: target, routes: count('SELECT COUNT(*) AS n FROM routes'), groups: count('SELECT COUNT(*) AS n FROM ops_groups'), materials: count('SELECT COUNT(*) AS n FROM content_items'), images: files.length };
    } finally {
      try { unlinkSync(temp); } catch { /* 临时文件删不掉不影响 */ }
    }
  }

  /** 检查备份文件并放进待恢复目录，重启后生效。返回备份的时间。 */
  stage(source: string): string {
    let backup: BackupFile;
    try { backup = JSON.parse(readFileSync(source, 'utf8')) as BackupFile; } catch { throw new Error('这个文件不是旅游运营助手的备份'); }
    if (backup?.format !== FORMAT || typeof backup.database !== 'string') throw new Error('这个文件不是旅游运营助手的备份');
    const database = Buffer.from(backup.database, 'base64');
    // 先确认是能打开的数据库
    const check = join(this.userData, `restore-check-${Date.now()}.sqlite`);
    writeFileSync(check, database);
    try { const probe = new DatabaseSync(check); probe.prepare('SELECT COUNT(*) FROM ops_groups').get(); probe.close(); }
    catch { throw new Error('备份文件已损坏，无法恢复'); }
    finally { try { unlinkSync(check); } catch { /* ignore */ } }
    const filesDir = join(this.userData, PENDING_FILES);
    rmSync(filesDir, { recursive: true, force: true });
    mkdirSync(filesDir, { recursive: true });
    for (const file of backup.files ?? []) {
      if (!/^[\w.-]+$/.test(file.name)) continue;
      writeFileSync(join(filesDir, file.name), Buffer.from(file.data, 'base64'));
    }
    writeFileSync(join(this.userData, PENDING_DB), database);
    return backup.createdAt;
  }
}

/**
 * 程序启动、打开数据库之前调用：有待恢复的备份就替换数据库（原来的改名留作 .before-restore），
 * 图片复制进素材目录，并把图片路径改成这台电脑上的路径。
 */
export function applyPendingRestore(userData: string, dbPath: string, filesDir: string): boolean {
  const pending = join(userData, PENDING_DB);
  if (!existsSync(pending)) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.before-restore-${stamp}`);
  for (const suffix of ['-wal', '-shm']) { try { unlinkSync(`${dbPath}${suffix}`); } catch { /* 没有就算了 */ } }
  renameSync(pending, dbPath);
  mkdirSync(filesDir, { recursive: true });
  const staged = join(userData, PENDING_FILES);
  if (existsSync(staged)) {
    for (const name of readdirSync(staged)) copyFileSync(join(staged, name), join(filesDir, name));
    rmSync(staged, { recursive: true, force: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id, file_path FROM media_assets').all() as unknown as Array<{ id: string; file_path: string }>;
    const update = db.prepare('UPDATE media_assets SET file_path = ? WHERE id = ?');
    for (const row of rows) update.run(join(filesDir, basename(row.file_path.replace(/\\/g, '/'))), row.id);
  } finally { db.close(); }
  return true;
}
