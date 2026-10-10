import { app, BrowserWindow, dialog, Tray, Menu, nativeImage, Notification } from 'electron';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { TravelDatabase } from './services/database';
import { OpenMeteoWeatherProvider, tourWeatherText } from './services/weather';
import { migrateOpsSchema, BatchRepository, GroupRepository, LogRepository, MaterialRepository, RouteRepository, TemplateRepository, WeatherRuleRepository } from './infrastructure/repositories';
import { LocalFileStore } from './infrastructure/file-store';
import { PowerShellRpaGateway } from './infrastructure/desktop-rpa';
import { JsonSendSettingsStore } from './infrastructure/settings-store';
import { JsonMailSettingsStore } from './infrastructure/mail-store';
import { SmtpMailSender } from './infrastructure/smtp-mailer';
import { lanAddresses, RemoteRpaAccount, RpaAgentServer } from './infrastructure/rpa-agent';
import { applyPendingRestore, BackupStore } from './infrastructure/backup';
import { RpaExecutor } from './application/rpa-executor';
import { localDateText, LOCAL_ACCOUNT_ID, type DayWeather, type RpaAccount, type SendSettings } from '../src/domain/ops';
import { DashboardService, DistributionService, GroupService, LogService, MailAlertService, MaterialService, PlanService, RouteService, SendSettingsService, TemplateService } from './application/services';
import type { RpaAccountClient, WeatherGateway } from './application/ports';
import { registerOpsApi } from './api/ops-ipc';
import { SampleDataService } from './application/sample-data';

// 旅游运营助手 RPA 版：所有发送都通过本机（或局域网执行端）的企业微信 / 微信桌面客户端完成，不调用企业微信官方接口。

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let travelDatabase: TravelDatabase | null = null;
let opsTimer: NodeJS.Timeout | null = null;
const startHidden = process.argv.includes('--hidden');
const weatherProvider = new OpenMeteoWeatherProvider();

function createWindow() {
  mainWindow = new BrowserWindow({ title: '旅游运营助手（RPA 版）', show: !startHidden, width: 1280, height: 820, minWidth: 1080, minHeight: 680, backgroundColor: '#fff8f2', webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

/** 天气：同一个城市同一天 30 分钟内只查一次（几十个团在同一个城市时不重复请求）。 */
const weatherCache = new Map<string, { at: number; value: DayWeather }>();
const weatherGateway: WeatherGateway = {
  async forecast(city, date) {
    const key = `${city}|${date}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value;
    const forecast = await weatherProvider.getForecastForDate(city, date);
    if (!Number.isFinite(forecast.minC) || !Number.isFinite(forecast.maxC)) throw new Error('天气服务没有返回气温');
    const value: DayWeather = { city: forecast.location, date: forecast.date, condition: tourWeatherText(forecast.weatherCode, forecast.precipitationProbability), min: forecast.minC, max: forecast.maxC };
    weatherCache.set(key, { at: Date.now(), value });
    return value;
  },
};

function setupOps(database: TravelDatabase, filesDir: string) {
  const db = database.connection;
  migrateOpsSchema(db);
  const userData = app.getPath('userData');
  const materialRepo = new MaterialRepository(db); const routeRepo = new RouteRepository(db); const groupRepo = new GroupRepository(db); const batchRepo = new BatchRepository(db);
  const logs = new LogService(new LogRepository(db));
  const files = new LocalFileStore(filesDir);
  const picker = { async pickImages() {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择素材图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    return result.canceled ? [] : result.filePaths;
  } };
  const materials = new MaterialService(materialRepo, routeRepo, files, picker);
  const routes = new RouteService(routeRepo, materialRepo, groupRepo, logs);
  const templates = new TemplateService(new TemplateRepository(db), new WeatherRuleRepository(db), weatherGateway);
  // RPA 设置（客户端、防封、账号池、傍晚开始时间），每次发送时读取
  const sendStore = new JsonSendSettingsStore(join(userData, 'send-settings.json'));
  const rpa = new PowerShellRpaGateway(() => sendStore.get().rpa, join(userData, 'rpa'));
  // 客户端弹出安全验证时弹系统通知、闪烁任务栏，并按设置发提醒邮件：验证有时限，超时会被退出登录
  const mail = new MailAlertService(new JsonMailSettingsStore(join(userData, 'mail-settings.json')), new SmtpMailSender(), logs, () => hostname());
  const alertLocked = (reason: string) => {
    if (Notification.isSupported()) new Notification({ title: '企业微信要求安全验证，已暂停发送', body: reason }).show();
    mainWindow?.flashFrame(true);
    void mail.alert('企业微信要求安全验证，已暂停发送', `${reason}\n\n验证通常有 5 分钟时限，超时会被退出登录。请尽快在这台电脑的企业微信窗口里用手机扫码，然后在旅游运营助手的“设置”里点“检测本机客户端”恢复发送。`);
  };
  // 账号池：本机账号用执行器直接发；远程账号转给局域网里的执行端。本机切成执行端时启动局域网服务
  const localRpa = new RpaExecutor(LOCAL_ACCOUNT_ID, rpa, () => sendStore.get().rpa, logs, alertLocked);
  const accountClient = (account: RpaAccount): RpaAccountClient => account.kind === 'local' ? localRpa : new RemoteRpaAccount(account);
  const agentServer = new RpaAgentServer(localRpa, join(userData, 'rpa', 'incoming'));
  const applyPool = (settings: SendSettings) => {
    agentServer.apply(settings.pool.role === 'agent', settings.pool.agentPort, settings.pool.agentToken);
    // 开机自动启动（最小化到托盘），只对安装后的 Windows 版生效
    if (process.platform === 'win32' && app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.tour.launchAtLogin, args: ['--hidden'] });
  };
  const sendSettings = new SendSettingsService(sendStore, localRpa, accountClient, () => {
    const pool = sendStore.get().pool;
    return { addresses: lanAddresses(), port: pool.agentPort, token: pool.agentToken, listening: agentServer.listening, error: agentServer.error || undefined };
  }, logs, applyPool);
  applyPool(sendStore.get());
  app.on('before-quit', () => agentServer.stop());
  const groups = new GroupService(groupRepo, routeRepo, materialRepo, batchRepo, logs, () => sendStore.get());
  const distribution = new DistributionService(accountClient, () => sendStore.get(), logs, groupId => groups.markSent(groupId));
  const plans = new PlanService(batchRepo, groups, routes, materials, templates, distribution, () => sendStore.get(), logs);
  const dashboard = new DashboardService(plans, groups, logs, () => sendStore.get());
  plans.recoverAfterRestart();
  logs.prune();
  const sampleRoot = app.isPackaged ? join(process.resourcesPath, 'sample-data') : join(app.getAppPath(), 'sample-data');
  const samples = new SampleDataService(sampleRoot, materialRepo, files, routes, groups, logs);
  const backupStore = new BackupStore(db, userData, filesDir);
  const backup = {
    async export() {
      const result = await dialog.showSaveDialog(mainWindow!, { title: '导出备份', defaultPath: `旅游运营助手备份-${localDateText(new Date())}.travelbot`, filters: [{ name: '旅游运营助手备份', extensions: ['travelbot'] }] });
      if (result.canceled || !result.filePath) return null;
      const exported = backupStore.export(result.filePath);
      logs.write({ module: 'System', action: '导出备份', status: 'ok', message: `${exported.path}：路线 ${exported.routes} 条、群 ${exported.groups} 个、素材 ${exported.materials} 条、图片 ${exported.images} 张` });
      return exported;
    },
    async restore() {
      const result = await dialog.showOpenDialog(mainWindow!, { title: '选择备份文件', properties: ['openFile'], filters: [{ name: '旅游运营助手备份', extensions: ['travelbot'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      const createdAt = backupStore.stage(result.filePaths[0]);
      const confirm = await dialog.showMessageBox(mainWindow!, { type: 'warning', buttons: ['恢复并重启', '取消'], defaultId: 1, cancelId: 1, title: '从备份恢复', message: `用 ${new Date(createdAt).toLocaleString('zh-CN', { hour12: false })} 的备份替换现在的全部数据？`, detail: '现在的数据会另存一份（数据目录里的 .before-restore 文件），恢复后程序自动重启。' });
      if (confirm.response !== 0) return null;
      logs.write({ module: 'System', action: '恢复备份', status: 'info', message: `用 ${createdAt} 的备份恢复，程序重启` });
      setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 300);
      return createdAt;
    },
  };
  registerOpsApi({ dashboard, materials, routes, templates, plans, groups, logs, sendSettings, mail, samples, backup });
  logs.write({ module: 'System', action: '启动', status: 'info', message: `旅游运营助手 RPA 版 ${app.getVersion()} 已启动` });
  // 调度器：每 30 秒检查一次，过了傍晚开始时间就给进行中的团发今天这一组
  const tick = () => { void plans.runDue().catch(error => logs.write({ module: 'Scheduler', action: '调度', status: 'fail', message: error?.message || String(error) })); };
  opsTimer = setInterval(tick, 30 * 1000);
  setTimeout(tick, 5000);
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const dbPath = join(userData, 'travelbot.sqlite');
  const filesDir = join(userData, 'files');
  const restored = applyPendingRestore(userData, dbPath, filesDir);
  travelDatabase = new TravelDatabase(dbPath);
  setupOps(travelDatabase, filesDir);
  createWindow();
  if (restored) mainWindow?.once('ready-to-show', () => { void dialog.showMessageBox(mainWindow!, { type: 'info', title: '已从备份恢复', message: '数据已从备份恢复。' }); });
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('旅游运营助手');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开旅游运营助手', click: () => { mainWindow?.show(); mainWindow?.focus(); } }, { label: '退出', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { if (opsTimer) clearInterval(opsTimer); travelDatabase?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
