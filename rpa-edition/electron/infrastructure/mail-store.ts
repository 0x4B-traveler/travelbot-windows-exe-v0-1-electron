import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailSettings } from '../../src/domain/ops';
import type { MailServer, MailSettingsStore } from '../application/ports';

type Stored = MailSettings & { encryptedPassword?: string };
const EMPTY: MailSettings = { enabled: false, host: '', port: 465, secure: true, user: '', to: '' };

/** 提醒邮件设置存在 userData 下；邮箱授权码用系统级加密（Windows DPAPI）保存，界面拿不到明文。 */
export class JsonMailSettingsStore implements MailSettingsStore {
  constructor(private readonly path: string) {}

  get(): MailSettings & { hasPassword: boolean } {
    const { encryptedPassword, ...settings } = this.read();
    return { ...settings, hasPassword: Boolean(encryptedPassword) };
  }

  save(settings: MailSettings, password?: string) {
    const current = this.read();
    const next: Stored = { ...settings, encryptedPassword: current.encryptedPassword };
    if (password) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持加密存储，无法安全保存邮箱授权码');
      next.encryptedPassword = safeStorage.encryptString(password).toString('base64');
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2), 'utf8');
  }

  server(password?: string): MailServer | null {
    const stored = this.read();
    let secret = password ?? '';
    if (!secret && stored.encryptedPassword) {
      try { secret = safeStorage.decryptString(Buffer.from(stored.encryptedPassword, 'base64')); } catch { secret = ''; }
    }
    if (!stored.host || !stored.user || !secret) return null;
    return { host: stored.host, port: stored.port, secure: stored.secure, user: stored.user, password: secret };
  }

  private read(): Stored {
    try { return { ...EMPTY, ...JSON.parse(readFileSync(this.path, 'utf8')) }; } catch { return { ...EMPTY }; }
  }
}
