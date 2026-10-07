import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edition } from '../src/domain/ops';

/** 主进程所属的版本：安装包里的 package.json 有 edition 字段（scripts/build.js 写入），开发时读 TRAVELBOT_EDITION，默认 RPA 版。 */
export function appEdition(): Edition {
  try {
    const edition = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))?.edition;
    if (edition === 'api' || edition === 'rpa') return edition;
  } catch { /* 读不到就按环境变量 */ }
  return process.env.TRAVELBOT_EDITION === 'api' ? 'api' : 'rpa';
}
