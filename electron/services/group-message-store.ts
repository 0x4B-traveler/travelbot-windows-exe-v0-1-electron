import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GroupMessageConfigInput, GroupMessageConfigView, GroupMessageRecord } from '../../src/domain/business';
import type { WeComApiCredentials } from './wecom-api';

type StoredConfig = { corpId: string; senderUserId: string; encryptedSecret?: string };
const HISTORY_LIMIT = 50;

/** 客户群群发配置与发送记录，保存在 userData 目录；Secret 使用系统级加密（Windows DPAPI）。 */
export class GroupMessageStore {
  private readonly configPath: string;
  private readonly historyPath: string;

  constructor(userDataDir: string) {
    this.configPath = join(userDataDir, 'wecom-groupmsg-config.json');
    this.historyPath = join(userDataDir, 'wecom-groupmsg-history.json');
  }

  getConfigView(): GroupMessageConfigView {
    const config = this.readConfig();
    return { corpId: config.corpId, senderUserId: config.senderUserId, hasSecret: Boolean(config.encryptedSecret), encryptionAvailable: safeStorage.isEncryptionAvailable() };
  }

  saveConfig(input: GroupMessageConfigInput): GroupMessageConfigView {
    const current = this.readConfig();
    const next: StoredConfig = { corpId: input.corpId.trim(), senderUserId: input.senderUserId.trim(), encryptedSecret: current.encryptedSecret };
    const secret = input.secret?.trim();
    if (secret) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持加密存储，无法安全保存 Secret');
      next.encryptedSecret = safeStorage.encryptString(secret).toString('base64');
    }
    writeJson(this.configPath, next);
    return this.getConfigView();
  }

  credentials(): WeComApiCredentials | null {
    const config = this.readConfig();
    if (!config.corpId || !config.encryptedSecret) return null;
    try { return { corpId: config.corpId, secret: safeStorage.decryptString(Buffer.from(config.encryptedSecret, 'base64')) }; } catch { return null; }
  }

  senderUserId(): string { return this.readConfig().senderUserId; }

  listHistory(): GroupMessageRecord[] {
    try { const parsed = JSON.parse(readFileSync(this.historyPath, 'utf8')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }

  addHistory(record: GroupMessageRecord) { writeJson(this.historyPath, [record, ...this.listHistory()].slice(0, HISTORY_LIMIT)); }

  private readConfig(): StoredConfig {
    try { const raw = JSON.parse(readFileSync(this.configPath, 'utf8')); return { corpId: raw.corpId ?? '', senderUserId: raw.senderUserId ?? '', encryptedSecret: raw.encryptedSecret }; } catch { return { corpId: '', senderUserId: '' }; }
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}
