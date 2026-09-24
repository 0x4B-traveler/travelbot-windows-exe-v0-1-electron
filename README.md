# TravelBot Windows EXE V0.1

Electron + React + TypeScript PoC for the real `@wecom/cli` flow:

1. `wecom-cli auth init --noninteractive --no-browser --output-qrcode ...`
2. `wecom-cli auth show --status`
3. `wecom-cli identity whoami`
4. `wecom-cli message aibot send --json ...`

## Build and run

Requires Node.js 18+ and Windows x64. `npm install` installs the official CLI and its Windows binary.

```powershell
npm install
npm run typecheck
npm run dev
npm run build
```

The installer is generated under `dist/TravelBot-Setup-0.1.0.exe`. The app stores the CLI credential directory under the Windows app data directory and never displays or logs the credential contents.

The test message is sent to the identity returned by the official CLI. This respects wecom-cli's rule that the target must be the authorized user or a current permitted session.
# TravelBot Windows

TravelBot Windows 是一个基于 Electron、React 和 TypeScript 的企业微信桌面工具。

## 当前业务层

业务逻辑与通用 UI 分离，核心服务位于 `electron/services`，共享类型位于 `src/domain`：

- `database.ts`：使用 Electron 内置 `node:sqlite`，在当前 Windows 用户数据目录保存 `travelbot.sqlite`，支持攻略/路线等内容的增删改查。
- `weather.ts`：通过 Open-Meteo 地理编码和实时天气接口获取指定位置天气，并生成规则化问候语。
- `natural-language.ts`：将“查询/新增/修改/删除”类中文消息解析为结构化命令；写操作默认要求二次确认。
- Electron IPC：已暴露天气预览、内容搜索、自然语言解析和确认执行接口，UI 可在后续独立接入。

## 数据边界

SQLite 文件和企业微信凭证都保存在 Electron 的 `userData` 目录，不写入项目目录。图片文件暂时只预留 `media_assets` 表，下一步接入图片导入和预览。

## 验证

```powershell
npm run typecheck
npm run build
```

天气和 SQLite 的本地冒烟验证脚本位于被忽略的 `work/` 目录中。
