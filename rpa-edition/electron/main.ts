import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage, Notification } from 'electron';
import { join } from 'node:path';
import type { CustomerGroup, DailyPushSettings, ItineraryItem, ItinerarySettings } from '../src/domain/business';
import { TravelDatabase } from './services/database';
import { formatForecast, OpenMeteoWeatherProvider } from './services/weather';
import { DailyPushRunner, DailyPushStore, localDate, parseSendTime } from './services/daily-push';
import { ItineraryRunner, ItineraryStore, normalizeName, parseItinerary } from './services/itinerary';
import { migrateOpsSchema, ContentRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TaskRepository } from './infrastructure/repositories';
import { LocalFileStore } from './infrastructure/file-store';
import { TemplateContentGenerator } from './infrastructure/template-generator';
import { PowerShellRpaGateway } from './infrastructure/desktop-rpa';
import { JsonSendSettingsStore } from './infrastructure/settings-store';
import { JsonMailSettingsStore } from './infrastructure/mail-store';
import { SmtpMailSender } from './infrastructure/smtp-mailer';
import { hostname } from 'node:os';
import { lanAddresses, RemoteRpaAccount, RpaAgentServer } from './infrastructure/rpa-agent';
import { RpaExecutor } from './application/rpa-executor';
import { LOCAL_ACCOUNT_ID, type RpaAccount, type SendSettings } from '../src/domain/ops';
import { ContentService, DashboardService, DistributionService, GroupService, LogService, MailAlertService, MaterialService, RouteService, SendSettingsService, TaskService } from './application/services';
import type { RpaAccountClient, WeatherGateway } from './application/ports';
import { registerOpsApi } from './api/ops-ipc';
import { SampleDataService } from './application/sample-data';

// 旅游运营助手 RPA 版：所有发送都通过本机（或局域网执行端）的企业微信 / 微信桌面客户端完成，不调用企业微信官方接口。

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let travelDatabase: TravelDatabase | null = null;
let dailyPushStore: DailyPushStore | null = null;
let dailyPushRunner: DailyPushRunner | null = null;
let dailyPushTimer: NodeJS.Timeout | null = null;
let itineraryStore: ItineraryStore | null = null;
let itineraryRunner: ItineraryRunner | null = null;
let itineraryTimer: NodeJS.Timeout | null = null;
let opsTimer: NodeJS.Timeout | null = null;
const startHidden = process.argv.includes('--hidden');
const weatherProvider = new OpenMeteoWeatherProvider();
/** 群管理里的群，供行程提醒（按群名匹配）和每日推送（选群）使用；setupOps 后可用。 */
let listGroups: () => CustomerGroup[] = () => [];
/** 把同一段内容通过 RPA 逐个发到这些群（chatId 是群管理里的群编号）。 */
let sendToGroups: (input: { chatIds: string[]; content: string; action: string }) => Promise<{ failed: Record<string, string> }> = async () => { throw new Error('发送模块尚未初始化'); };

// 每分钟检查一次是否到了每日推送时刻；电脑休眠唤醒或程序晚启动时也能在补发窗口内补上。
function startDailyPush() {
  if (dailyPushTimer) clearInterval(dailyPushTimer);
  const tick = () => { void dailyPushRunner?.tick().catch(() => { /* 结果已写入状态 */ }); };
  dailyPushTimer = setInterval(tick, 60 * 1000);
  tick();
}
// 行程提醒：每分钟检查到点的行程任务并发送。
function startItinerary() {
  if (itineraryTimer) clearInterval(itineraryTimer);
  const tick = () => { void itineraryRunner?.tick().catch(() => { /* 结果已写入状态 */ }); };
  itineraryTimer = setInterval(tick, 60 * 1000);
  tick();
}
function applyLaunchAtLogin(enabled: boolean) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}
function createWindow() {
  mainWindow = new BrowserWindow({ title: '旅游运营助手（RPA 版）', show: !startHidden, width: 1280, height: 820, minWidth: 1080, minHeight: 680, backgroundColor: '#08111f', webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

ipcMain.handle('daily-get', async () => dailyPushStore?.view());
ipcMain.handle('daily-save', async (_event, input: DailyPushSettings) => {
  if (!dailyPushStore) return { ok: false, stderr: '每日推送模块尚未初始化' };
  if (!parseSendTime(input.sendTime)) return { ok: false, stderr: '发送时间格式应为 HH:mm，例如 17:50' };
  const targets = input.targets.filter(target => target.chatId);
  if (input.enabled) {
    if (!targets.length) return { ok: false, stderr: '请至少选择一个群' };
    if (!(input.includeWeather && input.location.trim()) && !input.includeRecommendation) return { ok: false, stderr: '请至少启用天气或今日推荐' };
  }
  dailyPushStore.saveSettings({ ...input, sendTime: input.sendTime.trim(), location: input.location.trim(), targets });
  applyLaunchAtLogin(input.launchAtLogin);
  return { ok: true, view: dailyPushStore.view() };
});
ipcMain.handle('daily-preview', async (_event, input?: DailyPushSettings) => dailyPushRunner?.preview(input) ?? { ok: false, stderr: '每日推送模块尚未初始化' });
ipcMain.handle('daily-run', async () => dailyPushRunner ? { ...(await dailyPushRunner.run()), view: dailyPushStore?.view() } : { ok: false, created: [], errors: [], message: '每日推送模块尚未初始化' });
const itineraryView = () => itineraryStore!.view(listGroups());
ipcMain.handle('itinerary-get', async () => itineraryStore ? itineraryView() : undefined);
ipcMain.handle('itinerary-save-settings', async (_event, input: ItinerarySettings) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  if (!parseSendTime(input.digestTime)) return { ok: false, stderr: '每日行程发送时间格式应为 HH:mm，例如 20:00' };
  const lead = Number(input.reminderLeadMinutes);
  if (!Number.isFinite(lead) || lead < 0 || lead > 24 * 60) return { ok: false, stderr: '单独提醒提前时间应在 0 到 1440 分钟之间' };
  itineraryStore.saveSettings({ enabled: input.enabled, dryRun: input.dryRun, digestTime: input.digestTime.trim(), reminderLeadMinutes: Math.round(lead), includeWeather: input.includeWeather, footer: input.footer });
  return { ok: true, view: itineraryView() };
});
ipcMain.handle('itinerary-parse', async (_event, text: string) => parseItinerary(text));
ipcMain.handle('itinerary-import', async (_event, input: { text: string; mode: 'append' | 'replace' }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  const parsed = parseItinerary(input.text);
  if (!parsed.items.length) return { ok: false, stderr: parsed.errors.join('\n') || '没有可导入的行程', errors: parsed.errors };
  itineraryStore.saveItems(input.mode === 'replace' ? parsed.items : [...itineraryStore.items(), ...parsed.items]);
  return { ok: true, added: parsed.items.length, errors: parsed.errors, view: itineraryView() };
});
ipcMain.handle('itinerary-update-item', async (_event, input: { id: string; patch: Partial<Pick<ItineraryItem, 'separate'>> }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  itineraryStore.saveItems(itineraryStore.items().map(item => item.id === input.id ? { ...item, separate: Boolean(input.patch.separate) } : item));
  return { ok: true, view: itineraryView() };
});
ipcMain.handle('itinerary-delete-items', async (_event, input: { ids?: string[]; groupName?: string; beforeToday?: boolean }) => {
  if (!itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  const todayText = localDate(new Date());
  const remove = (item: ItineraryItem) => Boolean(input.ids?.includes(item.id) || (input.groupName && normalizeName(item.groupName) === normalizeName(input.groupName)) || (input.beforeToday && item.date < todayText));
  itineraryStore.saveItems(itineraryStore.items().filter(item => !remove(item)));
  return { ok: true, view: itineraryView() };
});
ipcMain.handle('itinerary-preview-job', async (_event, jobId: string) => itineraryRunner?.preview(jobId) ?? { ok: false, stderr: '行程模块尚未初始化' });
ipcMain.handle('itinerary-run-job', async (_event, jobId: string) => {
  if (!itineraryRunner || !itineraryStore) return { ok: false, message: '行程模块尚未初始化' };
  return { ...(await itineraryRunner.runJob(jobId)), view: itineraryView() };
});
ipcMain.handle('open-image', async (_event, path: string) => { await shell.openPath(path); return true; });
const weatherGateway: WeatherGateway = {
  async forecastLine(city, date) {
    const forecast = await weatherProvider.getForecastForDate(city, localDate(date));
    return formatForecast(forecast, '今日');
  },
};

function setupOps(database: TravelDatabase) {
  const db = database.connection;
  migrateOpsSchema(db);
  const materialRepo = new MaterialRepository(db); const routeRepo = new RouteRepository(db); const groupRepo = new GroupRepository(db);
  const logs = new LogService(new LogRepository(db));
  const files = new LocalFileStore(join(app.getPath('userData'), 'files'));
  const picker = { async pickImages() {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择素材图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    return result.canceled ? [] : result.filePaths;
  } };
  const materials = new MaterialService(materialRepo, routeRepo, files, picker);
  const routes = new RouteService(routeRepo, materialRepo);
  const taskRepo = new TaskRepository(db);
  // RPA 设置（客户端、防封、账号池），DistributionService 每次发送时读取
  const sendStore = new JsonSendSettingsStore(join(app.getPath('userData'), 'send-settings.json'));
  const rpa = new PowerShellRpaGateway(() => sendStore.get().rpa, join(app.getPath('userData'), 'rpa'));
  // 账号池：本机账号用执行器直接发；远程账号转给局域网里的执行端。本机切成执行端时启动局域网服务
  // 客户端弹出安全验证时弹系统通知、闪烁任务栏，并按设置发提醒邮件：验证有时限，超时会被退出登录
  const mail = new MailAlertService(new JsonMailSettingsStore(join(app.getPath('userData'), 'mail-settings.json')), new SmtpMailSender(), logs, () => hostname());
  const alertLocked = (reason: string) => {
    if (Notification.isSupported()) new Notification({ title: '企业微信要求安全验证，已暂停发送', body: reason }).show();
    mainWindow?.flashFrame(true);
    void mail.alert('企业微信要求安全验证，已暂停发送', `${reason}\n\n验证通常有 5 分钟时限，超时会被退出登录。请尽快在这台电脑的企业微信窗口里用手机扫码，然后在旅游运营助手的“设置”里点“检测本机客户端”恢复发送。`);
  };
  const localRpa = new RpaExecutor(LOCAL_ACCOUNT_ID, rpa, () => sendStore.get().rpa, logs, alertLocked);
  const accountClient = (account: RpaAccount): RpaAccountClient => account.kind === 'local' ? localRpa : new RemoteRpaAccount(account);
  const agentServer = new RpaAgentServer(localRpa, join(app.getPath('userData'), 'rpa', 'incoming'));
  const applyPool = (settings: SendSettings) => agentServer.apply(settings.pool.role === 'agent', settings.pool.agentPort, settings.pool.agentToken);
  const sendSettings = new SendSettingsService(sendStore, localRpa, accountClient, () => {
    const pool = sendStore.get().pool;
    return { addresses: lanAddresses(), port: pool.agentPort, token: pool.agentToken, listening: agentServer.listening, error: agentServer.error || undefined };
  }, logs, applyPool);
  applyPool(sendStore.get());
  app.on('before-quit', () => agentServer.stop());
  const contents = new ContentService(new ContentRepository(db), routes, materials, new TemplateContentGenerator(), logs, contentId => taskRepo.byContent(contentId));
  let distribution: DistributionService;
  const groups = new GroupService(groupRepo, logs, () => distribution, () => sendStore.get());
  distribution = new DistributionService(accountClient, () => sendStore.get(), logs, groupId => groups.markSent(groupId));
  const tasks = new TaskService(taskRepo, contents, groups, distribution, weatherGateway, logs);
  // 行程提醒、每日推送：群来自群管理，发送同样走账号池和防封规则，群与群之间随机间隔
  listGroups = () => groups.list().filter(group => group.enabled).map(group => ({ chatId: group.id, name: group.name, owner: '', memberCount: 0 }));
  sendToGroups = async ({ chatIds, content, action }) => {
    const failed: Record<string, string> = {};
    for (const chatId of chatIds) {
      let group;
      try { group = groups.get(chatId); } catch { failed[chatId] = '群已在群管理里删除'; continue; }
      const result = await distribution.send(group, content, { action, paced: true });
      if (!result.ok) failed[chatId] = result.detail.replace(`${group.name}：`, '');
    }
    return { failed };
  };
  const dashboard = new DashboardService(tasks, contents, routes, groups);
  contents.migrateTemplates(db);
  tasks.recoverAfterRestart();
  logs.prune();
  const sampleRoot = app.isPackaged ? join(process.resourcesPath, 'sample-data') : join(app.getAppPath(), 'sample-data');
  const samples = new SampleDataService(sampleRoot, materialRepo, files, routes, contents, logs, tasks);
  registerOpsApi({ dashboard, materials, routes, contents, tasks, groups, logs, sendSettings, mail, samples });
  logs.write({ module: 'System', action: '启动', status: 'info', message: `旅游运营助手 RPA 版 ${app.getVersion()} 已启动` });
  // 调度器：每 30 秒检查一次到点的运营任务
  const tick = () => { void tasks.runDue().catch(error => logs.write({ module: 'Scheduler', action: '调度', status: 'fail', message: error?.message || String(error) })); };
  opsTimer = setInterval(tick, 30 * 1000);
  setTimeout(tick, 5000);
}

app.whenReady().then(() => {
  travelDatabase = new TravelDatabase(join(app.getPath('userData'), 'travelbot.sqlite'));
  const database = travelDatabase;
  dailyPushStore = new DailyPushStore(app.getPath('userData'));
  dailyPushRunner = new DailyPushRunner(dailyPushStore, { getForecast: (location, offset) => weatherProvider.getDailyForecast(location, offset), formatForecast, listRecommendations: () => database.listContentForRotation(), send: input => sendToGroups(input), groupName: chatId => listGroups().find(group => group.chatId === chatId)?.name });
  itineraryStore = new ItineraryStore(app.getPath('userData'));
  itineraryRunner = new ItineraryRunner(itineraryStore, { getForecast: (location, date) => weatherProvider.getForecastForDate(location, date), formatForecast, listGroups: () => listGroups(), send: input => sendToGroups(input) });
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
