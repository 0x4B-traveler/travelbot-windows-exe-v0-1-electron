import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import type { FileStore } from '../application/ports';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/** 素材图片复制到 userData/files 下统一保存，界面通过 data URL 显示（Windows 路径不能直接当 file:// 用）。 */
export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true }); }

  importFile(sourcePath: string): string {
    const target = join(this.root, `${randomUUID()}${extname(sourcePath).toLowerCase()}`);
    copyFileSync(sourcePath, target);
    return target;
  }

  dataUrl(path: string): string | null {
    if (!this.owns(path) || !existsSync(path)) return null;
    const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  }

  remove(path: string) {
    if (!this.owns(path)) return;
    try { unlinkSync(path); } catch { /* 文件已不存在 */ }
  }

  private owns(path: string) { return resolve(path).startsWith(resolve(this.root) + sep); }
}
