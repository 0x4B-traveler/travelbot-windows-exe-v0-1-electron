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

## 客户群群发（群发助手）

`wecom-api.ts` 直接调用企业微信服务端接口，把预设内容通过“客户群群发”发到客户群：

1. `gettoken`：用企业 ID 和客户联系 Secret 获取 access_token（主进程内缓存，不暴露给界面）。
2. `externalcontact/groupchat/list` + `groupchat/get`：列出发送人作为群主的客户群。
3. `externalcontact/add_msg_template`（`chat_type=group`）：创建群发任务，发送人在企业微信中收到通知并确认后发出。
4. `externalcontact/get_groupmsg_task` / `get_groupmsg_send_result`：查询确认状态和各群发送结果。

使用前需要在界面“客户群群发”中填写：

- 企业 ID（corpid）
- 客户联系 Secret（管理后台 → 客户与上下游 → 客户联系 → API；或开通了客户联系权限的自建应用 Secret）
- 发送人 userid（客户群群主，需在客户联系使用范围内）

Secret 通过 Electron `safeStorage`（Windows DPAPI）加密后保存在 `userData/wecom-groupmsg-config.json`。运行本程序的电脑公网 IP 必须加入该应用的“企业可信 IP”，否则接口返回 60020。后台定时发送可切换为“群发助手”通道，按间隔自动创建群发任务；企业微信对客户群群发有频率限制，建议按天发送。

## 每日客户群推送

界面“每日客户群推送”在 PR 群发助手链路之上实现每天一次的定时推送（`electron/services/daily-push.ts`）：

- 每天到设定时刻（默认 17:50），生成“天气预报 + 今日推荐 + 落款”：天气来自 Open-Meteo 逐日预报，12 点后发送时播报明天；今日推荐按创建顺序从本地资料库轮换。
- 按群主拆分目标客户群，每位群主创建一个 `add_msg_template` 任务；群主在企业微信点一次“发送”即发到他名下选中的全部客户群。消息在群主确认时发出，接口不支持预约发送时间。
- 每个客户群每天最多一条（含手动“立即创建”）；企业微信限制每个客户群每月接收条数不超过当月天数。
- 每分钟检查一次；程序晚启动或电脑休眠唤醒后，在发送时刻后 3 小时内补发，超过则当天跳过。部分群主创建失败时，10 分钟后只重试失败的群主，每天最多 3 次，内容与首次一致。
- 可勾选“开机自动启动”，以 `--hidden` 参数启动并最小化到托盘。

## 数据边界

SQLite 文件和企业微信凭证都保存在 Electron 的 `userData` 目录，不写入项目目录。图片文件暂时只预留 `media_assets` 表，下一步接入图片导入和预览。

## 验证

```powershell
npm run typecheck
npm run build
```

天气和 SQLite 的本地冒烟验证脚本位于被忽略的 `work/` 目录中。
