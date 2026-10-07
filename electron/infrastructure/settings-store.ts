import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SEND_SETTINGS, type SendSettings } from '../../src/domain/ops';
import type { SendSettingsStore } from '../application/ports';

/** 发送方式设置存成 userData 下的一个 JSON 文件，缺字段时用默认值补齐。 */
export class JsonSendSettingsStore implements SendSettingsStore {
  constructor(private readonly path: string) {}

  get(): SendSettings {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return {
        mode: raw?.mode === 'rpa' ? 'rpa' : 'api',
        rpa: { ...DEFAULT_SEND_SETTINGS.rpa, ...(raw?.rpa ?? {}), guard: { ...DEFAULT_SEND_SETTINGS.rpa.guard, ...(raw?.rpa?.guard ?? {}) } },
        pool: { ...DEFAULT_SEND_SETTINGS.pool, ...(raw?.pool ?? {}), accounts: Array.isArray(raw?.pool?.accounts) && raw.pool.accounts.length ? raw.pool.accounts : DEFAULT_SEND_SETTINGS.pool.accounts },
      };
    } catch { return structuredClone(DEFAULT_SEND_SETTINGS); }
  }

  save(settings: SendSettings) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(settings, null, 2), 'utf8');
  }
}
