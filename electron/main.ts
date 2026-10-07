import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DailyPushSettings, GroupMessageConfigInput, ItineraryItem, ItinerarySettings } from '../src/domain/business';
import { TravelDatabase } from './services/database';
import { GroupMessageStore } from './services/group-message-store';
import { WeComCustomerGroupApi } from './services/wecom-api';
import { formatForecast, OpenMeteoWeatherProvider } from './services/weather';
import { DailyPushRunner, DailyPushStore, localDate, parseSendTime } from './services/daily-push';
import { ItineraryRunner, ItineraryStore, normalizeName, parseItinerary } from './services/itinerary';
import { migrateOpsSchema, ContentRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TaskRepository } from './infrastructure/repositories';
import { LocalFileStore } from './infrastructure/file-store';
import { TemplateContentGenerator } from './infrastructure/template-generator';
import { ContentService, DashboardService, DistributionService, GroupService, LogService, MaterialService, RouteService, TaskService } from './application/services';
import type { BotGateway, CustomerGroupGateway, WeatherGateway } from './application/ports';
import { registerOpsApi } from './api/ops-ipc';

const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let authProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let quitting = false;
let travelDatabase: TravelDatabase | null = null;
let groupMessageStore: GroupMessageStore | null = null;
let customerGroupApi: WeComCustomerGroupApi | null = null;
let dailyPushStore: DailyPushStore | null = null;
let dailyPushRunner: DailyPushRunner | null = null;
let dailyPushTimer: NodeJS.Timeout | null = null;
let itineraryStore: ItineraryStore | null = null;
let itineraryRunner: ItineraryRunner | null = null;
let itineraryTimer: NodeJS.Timeout | null = null;
let opsTimer: NodeJS.Timeout | null = null;
let logService: LogService | null = null;
const startHidden = process.argv.includes('--hidden');
const weatherProvider = new OpenMeteoWeatherProvider();
type CachedGroup = { name: string; lastTime?: string; chatId?: string };
async function sendToChat(chatId: string, content: string) {
  const result = await runCli(['message', 'aibot', 'send', '--json', JSON.stringify({ chat_id: chatId, msg_type: 'markdown', markdown: { content } })]);
  if (!result.ok) return result;
  try {
    const body = JSON.parse(result.stdout);
    if (body?.success === true) return result;
    return { ok: false, stdout: result.stdout, stderr: body?.errmsg || body?.message || '企业微信接口未确认消息发送成功' };
  } catch { return { ok: false, stdout: result.stdout, stderr: '发送接口返回了无法解析的业务结果' }; }
}
// 每分钟检查一次是否到了每日推送时刻；电脑休眠唤醒或程序晚启动时也能在补发窗口内补上。
function startDailyPush() {
  if (dailyPushTimer) clearInterval(dailyPushTimer);
  const tick = () => { void dailyPushRunner?.tick().catch(() => { /* 结果已写入状态 */ }); };
  dailyPushTimer = setInterval(tick, 60 * 1000);
  tick();
}
// 行程定时群发：每分钟检查到点的行程任务，并回查群主确认状态。
function startItinerary() {
  if (itineraryTimer) clearInterval(itineraryTimer);
  const tick = () => { void itineraryRunner?.tick().catch(() => { /* 结果已写入状态 */ }); };
  itineraryTimer = setInterval(tick, 60 * 1000);
  tick();
}
function defaultOwners(owners: string[]) {
  const cleaned = [...new Set(owners.map(id => id.trim()).filter(Boolean))];
  const sender = groupMessageStore?.senderUserId();
  return cleaned.length ? cleaned : (sender ? [sender] : []);
}
function applyLaunchAtLogin(enabled: boolean) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}
function cliInvocation(args: string[]) {
  const packagedBinary = join(process.resourcesPath, 'wecom-cli.exe');
  const unpackedBinary = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@wecom', 'cli-win32-x64', 'bin', 'wecom-cli.exe');
  if (process.platform === 'win32' && existsSync(packagedBinary)) return { file: packagedBinary, args };
  if (process.platform === 'win32' && existsSync(unpackedBinary)) return { file: unpackedBinary, args };
  const script = join(app.getAppPath(), 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js');
  return { file: process.execPath, args: [script, ...args] };
}

async function listSessions(): Promise<{ ok: boolean; stderr?: string; groups: CachedGroup[] }> {
  const result = await runCli(['message', 'aibot', 'sessions', 'list']);
  if (!result.ok) return { ok: false, stderr: result.stderr, groups: [] as Array<{ name: string; lastTime?: string }> };
  try {
    const parsed = JSON.parse(result.stdout);
    const groups = Array.isArray(parsed?.sessions)
      ? parsed.sessions.filter((item: any) => item?.chat_type === 'group' && item?.chat_id).map((item: any) => ({ name: item.chat_name || `未命名群聊 · ${item.last_msg_time || '最近会话'}`, lastTime: item.last_msg_time, chatId: item.chat_id }))
      : [];
    return { ok: true, groups };
  } catch { return { ok: false, stderr: '会话列表返回了无法解析的 JSON', groups: [] as Array<{ name: string; lastTime?: string }> }; }
}

async function runCli(args: string[], options: { timeout?: number } = {}) {
  const configDir = join(app.getPath('userData'), 'wecom');
  mkdirSync(configDir, { recursive: true });
  try {
    const invocation = cliInvocation(args);
    const result = await execFileAsync(invocation.file, invocation.args, {
      cwd: app.getPath('userData'), timeout: options.timeout ?? 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WECOM_CLI_CONFIG_DIR: configDir },
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error: any) {
    return { ok: false, stdout: error.stdout?.trim() ?? '', stderr: error.stderr?.trim() ?? error.message ?? 'CLI 执行失败' };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({ title: '旅游运营助手', show: !startHidden, width: 1280, height: 820, minWidth: 1080, minHeight: 680, backgroundColor: '#08111f', webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

ipcMain.handle('auth-status', async () => runCli(['auth', 'show', '--status']));
// The renderer can't load a raw Windows path as file://C:\..., so hand it the QR as a data URL once the CLI has finished writing it.
async function readQrDataUrl(path: string): Promise<string | null> {
  const { statSync } = require('node:fs') as typeof import('node:fs');
  let lastSize = -1;
  for (let i = 0; i < 20; i += 1) {
    try { const size = statSync(path).size; if (size > 0 && size === lastSize) return `data:image/png;base64,${readFileSync(path).toString('base64')}`; lastSize = size; } catch { /* not written yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}
ipcMain.handle('auth-start', async () => {
  const qrcode = join(app.getPath('userData'), 'travelbot-auth.png');
  if (authProcess && !authProcess.killed) return { ok: true, pending: true, stdout: '授权流程已在等待扫码', stderr: '', qrcode: existsSync(qrcode) ? qrcode : null, qrcodeDataUrl: existsSync(qrcode) ? await readQrDataUrl(qrcode) : null };
  try { if (existsSync(qrcode)) require('node:fs').unlinkSync(qrcode); } catch { /* stale QR can be replaced by the CLI */ }
  const configDir = join(app.getPath('userData'), 'wecom');
  mkdirSync(configDir, { recursive: true });
  const invocation = cliInvocation(['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', qrcode]);
  authProcess = spawn(invocation.file, invocation.args, {
    cwd: app.getPath('userData'), windowsHide: true,
    env: { ...process.env, WECOM_CLI_CONFIG_DIR: configDir },
  });
  authProcess.on('close', () => { authProcess = null; });
  const deadline = Date.now() + 15000;
  while (!existsSync(qrcode) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
  if (!existsSync(qrcode)) return { ok: false, pending: false, stdout: '', stderr: '企业微信二维码生成失败，请重试', qrcode: null };
  return { ok: true, pending: true, stdout: '二维码已生成，等待扫码确认', stderr: '', qrcode, qrcodeDataUrl: await readQrDataUrl(qrcode) };
});
ipcMain.handle('groupmsg-get-config', async () => groupMessageStore?.getConfigView());
ipcMain.handle('groupmsg-save-config', async (_event, input: GroupMessageConfigInput) => {
  if (!groupMessageStore) return { ok: false, stderr: '群发模块尚未初始化' };
  try { const config = groupMessageStore.saveConfig(input); customerGroupApi?.reset(); return { ok: true, config }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '保存配置失败' }; }
});
ipcMain.handle('daily-get', async () => dailyPushStore?.view());
ipcMain.handle('daily-save', async (_event, input: DailyPushSettings) => {
  if (!dailyPushStore) return { ok: false, stderr: '每日推送模块尚未初始化' };
  if (!parseSendTime(input.sendTime)) return { ok: false, stderr: '发送时间格式应为 HH:mm，例如 17:50' };
  const ownerUserIds = [...new Set(input.ownerUserIds.map(id => id.trim()).filter(Boolean))];
  const targets = input.targets.filter(target => target.chatId && target.owner);
  if (input.enabled) {
    if (!groupMessageStore?.credentials()) return { ok: false, stderr: '请先在“设置 → 客户群群发”中配置企业 ID 和 Secret' };
    if (!targets.length) return { ok: false, stderr: '请至少选择一个客户群' };
    if (!(input.includeWeather && input.location.trim()) && !input.includeRecommendation) return { ok: false, stderr: '请至少启用天气或今日推荐' };
  }
  dailyPushStore.saveSettings({ ...input, sendTime: input.sendTime.trim(), location: input.location.trim(), ownerUserIds, targets });
  applyLaunchAtLogin(input.launchAtLogin);
  return { ok: true, view: dailyPushStore.view() };
});
ipcMain.handle('daily-list-groups', async (_event, ownerUserIds: string[]) => {
  if (!customerGroupApi) return { ok: false, stderr: '群发模块尚未初始化', groups: [] };
  const owners = [...new Set(ownerUserIds.map(id => id.trim()).filter(Boolean))];
  if (!owners.length) return { ok: false, stderr: '请先填写至少一个群主 userid', groups: [] };
  try { return { ok: true, groups: await customerGroupApi.listCustomerGroups(owners) }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '客户群列表加载失败', groups: [] }; }
});
ipcMain.handle('daily-preview', async (_event, input?: DailyPushSettings) => dailyPushRunner?.preview(input) ?? { ok: false, stderr: '每日推送模块尚未初始化' });
ipcMain.handle('daily-run', async () => dailyPushRunner ? { ...(await dailyPushRunner.run()), view: dailyPushStore?.view() } : { ok: false, created: [], errors: [], message: '每日推送模块尚未初始化' });
ipcMain.handle('itinerary-get', async () => itineraryStore?.view());
ipcMain.handle('itinerary-save-settings', async (_event, input: ItinerarySettings) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  if (!parseSendTime(input.digestTime)) return { ok: false, stderr: '每日行程创建时间格式应为 HH:mm，例如 20:00' };
  const lead = Number(input.reminderLeadMinutes);
  if (!Number.isFinite(lead) || lead < 0 || lead > 24 * 60) return { ok: false, stderr: '单独提醒提前时间应在 0 到 1440 分钟之间' };
  if (input.enabled && !input.dryRun && !groupMessageStore?.credentials()) return { ok: false, stderr: '请先在“设置 → 客户群群发”中配置企业 ID 和 Secret，或先开启干跑模式' };
  const current = itineraryStore.settings();
  // 客户群列表只由“加载客户群”更新，避免界面旧数据覆盖
  itineraryStore.saveSettings({ ...current, enabled: input.enabled, dryRun: input.dryRun, digestTime: input.digestTime.trim(), reminderLeadMinutes: Math.round(lead), includeWeather: input.includeWeather, footer: input.footer, ownerUserIds: defaultOwners(input.ownerUserIds) });
  return { ok: true, view: itineraryStore.view() };
});
ipcMain.handle('itinerary-load-groups', async (_event, ownerUserIds: string[]) => {
  if (!itineraryStore || !customerGroupApi) return { ok: false, stderr: '行程模块尚未初始化' };
  const owners = defaultOwners(ownerUserIds);
  if (!owners.length) return { ok: false, stderr: '请先填写至少一个群主 userid' };
  try {
    const groups = await customerGroupApi.listCustomerGroups(owners);
    itineraryStore.saveSettings({ ...itineraryStore.settings(), ownerUserIds: owners, groups, groupsLoadedAt: new Date().toISOString() });
    return { ok: true, view: itineraryStore.view() };
  } catch (error: any) { return { ok: false, stderr: error?.message || '客户群列表加载失败' }; }
});
ipcMain.handle('itinerary-parse', async (_event, text: string) => parseItinerary(text));
ipcMain.handle('itinerary-import', async (_event, input: { text: string; mode: 'append' | 'replace' }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  const parsed = parseItinerary(input.text);
  if (!parsed.items.length) return { ok: false, stderr: parsed.errors.join('\n') || '没有可导入的行程', errors: parsed.errors };
  itineraryStore.saveItems(input.mode === 'replace' ? parsed.items : [...itineraryStore.items(), ...parsed.items]);
  return { ok: true, added: parsed.items.length, errors: parsed.errors, view: itineraryStore.view() };
});
ipcMain.handle('itinerary-update-item', async (_event, input: { id: string; patch: Partial<Pick<ItineraryItem, 'separate'>> }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  itineraryStore.saveItems(itineraryStore.items().map(item => item.id === input.id ? { ...item, separate: Boolean(input.patch.separate) } : item));
  return { ok: true, view: itineraryStore.view() };
});
ipcMain.handle('itinerary-delete-items', async (_event, input: { ids?: string[]; groupName?: string; beforeToday?: boolean }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  const todayText = localDate(new Date());
  const remove = (item: ItineraryItem) => Boolean(input.ids?.includes(item.id) || (input.groupName && normalizeName(item.groupName) === normalizeName(input.groupName)) || (input.beforeToday && item.date < todayText));
  itineraryStore.saveItems(itineraryStore.items().filter(item => !remove(item)));
  return { ok: true, view: itineraryStore.view() };
});
ipcMain.handle('itinerary-preview-job', async (_event, jobId: string) => itineraryRunner?.preview(jobId) ?? { ok: false, stderr: '行程模块尚未初始化' });
ipcMain.handle('itinerary-run-job', async (_event, jobId: string) => {
  if (!itineraryRunner || !itineraryStore) return { ok: false, message: '行程模块尚未初始化' };
  if (!itineraryStore.settings().dryRun && !groupMessageStore?.credentials()) return { ok: false, message: '请先在“设置 → 客户群群发”中配置企业 ID 和 Secret，或开启干跑模式' };
  return { ...(await itineraryRunner.runJob(jobId)), view: itineraryStore.view() };
});
ipcMain.handle('itinerary-check-confirmations', async () => {
  if (!itineraryRunner || !itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  try { const confirmed = await itineraryRunner.checkConfirmations(new Date(), true); return { ok: true, confirmed, view: itineraryStore.view() }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '查询确认状态失败' }; }
});
ipcMain.handle('open-image', async (_event, path: string) => { await shell.openPath(path); return true; });
// Infrastructure 适配器：把现有的 wecom-cli、群发接口、天气服务包装成 Application 层需要的端口。
function createGateways() {
  const bot: BotGateway = {
    async listGroups() {
      const result = await listSessions();
      if (!result.ok) throw new Error(result.stderr || '机器人会话列表加载失败');
      return result.groups.filter(group => group.chatId).map(group => ({ chatId: group.chatId!, name: group.name }));
    },
    async sendText(chatId, text) {
      const result = await sendToChat(chatId, text);
      if (!result.ok) throw new Error(result.stderr || '机器人发送失败');
    },
  };
  const customer: CustomerGroupGateway = {
    configured: () => Boolean(groupMessageStore?.credentials() && groupMessageStore.senderUserId()),
    defaultSender: () => groupMessageStore?.senderUserId() ?? '',
    listGroups: owners => customerGroupApi!.listCustomerGroups(owners),
    async createGroupMessage(input) {
      const result = await customerGroupApi!.createGroupMessage(input);
      groupMessageStore?.addHistory({ msgid: result.msgid, createdAt: new Date().toISOString(), sender: input.sender, chatIds: input.chatIds, content: input.content, source: 'schedule' });
      return result;
    },
  };
  const weather: WeatherGateway = {
    async forecastLine(city, date) {
      const forecast = await weatherProvider.getForecastForDate(city, localDate(date));
      return formatForecast(forecast, '今日');
    },
  };
  return { bot, customer, weather };
}

function setupOps(database: TravelDatabase) {
  const db = database.connection;
  migrateOpsSchema(db);
  const { bot, customer, weather } = createGateways();
  const materialRepo = new MaterialRepository(db); const routeRepo = new RouteRepository(db); const groupRepo = new GroupRepository(db);
  const logs = new LogService(new LogRepository(db)); logService = logs;
  const files = new LocalFileStore(join(app.getPath('userData'), 'files'));
  const picker = { async pickImages() {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择素材图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    return result.canceled ? [] : result.filePaths;
  } };
  const materials = new MaterialService(materialRepo, routeRepo, files, picker);
  const routes = new RouteService(routeRepo, materialRepo);
  const taskRepo = new TaskRepository(db);
  const contents = new ContentService(new ContentRepository(db), routes, materials, new TemplateContentGenerator(), logs, contentId => taskRepo.byContent(contentId));
  let distribution: DistributionService;
  const groups = new GroupService(groupRepo, bot, customer, logs, () => distribution);
  distribution = new DistributionService(bot, customer, logs, groupId => groups.markSent(groupId));
  const tasks = new TaskService(taskRepo, contents, groups, distribution, weather, logs);
  const dashboard = new DashboardService(tasks, contents, routes, groups);
  contents.migrateTemplates(db);
  tasks.recoverAfterRestart();
  logs.prune();
  registerOpsApi({ dashboard, materials, routes, contents, tasks, groups, logs });
  logs.write({ module: 'System', action: '启动', status: 'info', message: `旅游运营助手 ${app.getVersion()} 已启动` });
  // 调度器：每 30 秒检查一次到点的运营任务
  const tick = () => { void tasks.runDue().catch(error => logs.write({ module: 'Scheduler', action: '调度', status: 'fail', message: error?.message || String(error) })); };
  opsTimer = setInterval(tick, 30 * 1000);
  setTimeout(tick, 5000);
}

/** 行程提醒、每日推送也是运营任务的来源，它们创建的群发同样写进运行日志。 */
function loggedCreateGroupMessage(module: 'Itinerary' | 'DailyPush') {
  return async (input: { sender: string; chatIds: string[]; content: string }) => {
    try {
      const result = await customerGroupApi!.createGroupMessage(input);
      logService?.write({ module: 'WeCom', action: module === 'Itinerary' ? '行程提醒群发' : '每日推送群发', status: 'ok', message: `已为 ${input.chatIds.length} 个客户群创建群发任务，等待 ${input.sender} 确认`, detail: `msgid=${result.msgid}` });
      return result;
    } catch (error: any) {
      logService?.write({ module: 'WeCom', action: module === 'Itinerary' ? '行程提醒群发' : '每日推送群发', status: 'fail', message: error?.message || String(error) });
      throw error;
    }
  };
}

app.whenReady().then(() => {
  travelDatabase = new TravelDatabase(join(app.getPath('userData'), 'travelbot.sqlite'));
  groupMessageStore = new GroupMessageStore(app.getPath('userData'));
  const store = groupMessageStore;
  customerGroupApi = new WeComCustomerGroupApi(() => store.credentials());
  const api = customerGroupApi;
  const database = travelDatabase;
  dailyPushStore = new DailyPushStore(app.getPath('userData'));
  dailyPushRunner = new DailyPushRunner(dailyPushStore, { getForecast: (location, offset) => weatherProvider.getDailyForecast(location, offset), formatForecast, listRecommendations: () => database.listContentForRotation(), createGroupMessage: loggedCreateGroupMessage('DailyPush'), addHistory: record => store.addHistory(record) });
  itineraryStore = new ItineraryStore(app.getPath('userData'));
  itineraryRunner = new ItineraryRunner(itineraryStore, { getForecast: (location, date) => weatherProvider.getForecastForDate(location, date), formatForecast, listCustomerGroups: owners => api.listCustomerGroups(owners), createGroupMessage: loggedCreateGroupMessage('Itinerary'), getGroupMessageResult: msgid => api.getGroupMessageResult(msgid), addHistory: record => store.addHistory(record) });
  setupOps(database);
  createWindow();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('旅游运营助手');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开旅游运营助手', click: () => { mainWindow?.show(); mainWindow?.focus(); } }, { label: '退出', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  startDailyPush();
  startItinerary();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { if (dailyPushTimer) clearInterval(dailyPushTimer); if (itineraryTimer) clearInterval(itineraryTimer); if (opsTimer) clearInterval(opsTimer); travelDatabase?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
