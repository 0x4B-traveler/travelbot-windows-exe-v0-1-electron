import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ContentKind, DailyPushSettings, GroupMessageConfigInput, GroupMessageRecord, ItineraryItem, ItinerarySettings, NaturalLanguageCommand, WeatherJobSettings } from '../src/domain/business';
import { TravelDatabase } from './services/database';
import { GroupMessageStore } from './services/group-message-store';
import { WeComCustomerGroupApi } from './services/wecom-api';
import { createWeatherGreeting, formatForecast, OpenMeteoWeatherProvider } from './services/weather';
import { DailyPushRunner, DailyPushStore, localDate, parseSendTime } from './services/daily-push';
import { parseNaturalLanguage } from './services/natural-language';
import { ItineraryRunner, ItineraryStore, normalizeName, parseItinerary } from './services/itinerary';

const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let authProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let quitting = false;
let scheduleTimer: NodeJS.Timeout | null = null;
let scheduleSending = false;
let weatherTimer: NodeJS.Timeout | null = null;
let weatherSending = false;
let travelDatabase: TravelDatabase | null = null;
let groupMessageStore: GroupMessageStore | null = null;
let customerGroupApi: WeComCustomerGroupApi | null = null;
let dailyPushStore: DailyPushStore | null = null;
let dailyPushRunner: DailyPushRunner | null = null;
let dailyPushTimer: NodeJS.Timeout | null = null;
let itineraryStore: ItineraryStore | null = null;
let itineraryRunner: ItineraryRunner | null = null;
let itineraryTimer: NodeJS.Timeout | null = null;
const startHidden = process.argv.includes('--hidden');
const weatherProvider = new OpenMeteoWeatherProvider();
// channel：bot = 通过 wecom-cli 智能机器人直接发送；groupmsg = 通过群发助手创建客户群群发任务
type ScheduleChannel = 'bot' | 'groupmsg';
type ScheduleSettings = { enabled: boolean; channel: ScheduleChannel; groupNames: string[]; chatIds: string[]; customerChatIds: string[]; intervalMinutes: number; message: string; lastRun?: string; lastResult?: string };
type CachedGroup = { name: string; lastTime?: string; chatId?: string };
const defaultSettings: ScheduleSettings = { enabled: false, channel: 'bot', groupNames: [], chatIds: [], customerChatIds: [], intervalMinutes: 60, message: 'TravelBot 定时通知', lastResult: '未启动' };
function settingsPath() { return join(app.getPath('userData'), 'travelbot-settings.json'); }
function loadSettings(): ScheduleSettings { try { const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')); return { ...defaultSettings, ...raw, groupNames: raw.groupNames ?? (raw.groupName ? [raw.groupName] : []), chatIds: raw.chatIds ?? (raw.chatId ? [raw.chatId] : []) }; } catch { return { ...defaultSettings }; } }
function saveSettings(settings: ScheduleSettings) { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8'); }
async function sendToChat(chatId: string, content: string) {
  const result = await runCli(['message', 'aibot', 'send', '--json', JSON.stringify({ chat_id: chatId, msg_type: 'markdown', markdown: { content } })]);
  if (!result.ok) return result;
  try {
    const body = JSON.parse(result.stdout);
    if (body?.success === true) return result;
    return { ok: false, stdout: result.stdout, stderr: body?.errmsg || body?.message || '企业微信接口未确认消息发送成功' };
  } catch { return { ok: false, stdout: result.stdout, stderr: '发送接口返回了无法解析的业务结果' }; }
}
async function sendGroupMessage(chatIds: string[], content: string, source: GroupMessageRecord['source']) {
  if (!groupMessageStore || !customerGroupApi) return { ok: false, stderr: '群发模块尚未初始化' };
  const sender = groupMessageStore.senderUserId();
  if (!sender) return { ok: false, stderr: '请先配置发送人 userid' };
  if (!chatIds.length) return { ok: false, stderr: '请先选择至少一个客户群' };
  if (!content.trim()) return { ok: false, stderr: '群发内容不能为空' };
  try {
    const { msgid, failList } = await customerGroupApi.createGroupMessage({ sender, chatIds, content });
    const record: GroupMessageRecord = { msgid, createdAt: new Date().toISOString(), sender, chatIds, content, source };
    groupMessageStore.addHistory(record);
    return { ok: true, record, failList };
  } catch (error: any) {
    return { ok: false, stderr: error?.message || '创建群发任务失败' };
  }
}
function stopSchedule() { if (scheduleTimer) clearInterval(scheduleTimer); scheduleTimer = null; }
function scheduleTargets(settings: ScheduleSettings) { return settings.channel === 'groupmsg' ? settings.customerChatIds : settings.chatIds; }
function startSchedule() { stopSchedule(); const settings = loadSettings(); if (!settings.enabled || !scheduleTargets(settings).length) return; scheduleTimer = setInterval(async () => { if (scheduleSending) return; scheduleSending = true; try { const current = loadSettings(); if (current.channel === 'groupmsg') { const result = await sendGroupMessage(current.customerChatIds, current.message, 'schedule'); current.lastRun = new Date().toISOString(); current.lastResult = result.ok ? `已创建群发任务（${current.customerChatIds.length} 个客户群），等待发送人确认` : (result.stderr || '创建群发任务失败'); saveSettings(current); return; } let sent = 0; let failure = ''; for (const chatId of current.chatIds) { const result = await sendToChat(chatId, current.message); if (result.ok) sent += 1; else { failure = result.stderr || '发送失败'; break; } } current.lastRun = new Date().toISOString(); current.lastResult = failure || `发送成功（${sent}/${current.chatIds.length} 个群聊）`; saveSettings(current); } finally { scheduleSending = false; } }, Math.max(1, settings.intervalMinutes) * 60 * 1000); }
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
function stopWeatherSchedule() { if (weatherTimer) clearInterval(weatherTimer); weatherTimer = null; }
async function runWeatherJob(): Promise<{ ok: boolean; stderr?: string; greeting?: ReturnType<typeof createWeatherGreeting> }> {
  if (!travelDatabase) return { ok: false, stderr: '本地数据库尚未初始化' };
  const job = travelDatabase.getWeatherJob();
  if (!job.location || !job.chatIds.length) return { ok: false, stderr: '请先配置天气位置和目标群聊' };
  try {
    const greeting = createWeatherGreeting(await weatherProvider.getCurrent(job.location));
    let sent = 0;
    for (const chatId of job.chatIds) { const result = await sendToChat(chatId, greeting.message); if (!result.ok) throw new Error(result.stderr || '天气问候发送失败'); sent += 1; }
    travelDatabase.saveWeatherJob({ ...job, lastSentAt: new Date().toISOString(), lastResult: `发送成功（${sent}/${job.chatIds.length} 个群聊）` });
    return { ok: true, greeting };
  } catch (error: any) {
    travelDatabase.saveWeatherJob({ ...job, lastSentAt: new Date().toISOString(), lastResult: error?.message || '天气任务失败' });
    return { ok: false, stderr: error?.message || '天气任务失败' };
  }
}
function startWeatherSchedule() { stopWeatherSchedule(); const job = travelDatabase?.getWeatherJob(); if (!job?.enabled || !job.location || !job.chatIds.length) return; weatherTimer = setInterval(async () => { if (weatherSending) return; weatherSending = true; try { await runWeatherJob(); } finally { weatherSending = false; } }, Math.max(1, job.intervalMinutes) * 60 * 1000); }

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
  mainWindow = new BrowserWindow({ show: !startHidden, width: 1120, height: 760, minWidth: 860, minHeight: 620, backgroundColor: '#08111f', webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

ipcMain.handle('auth-status', async () => runCli(['auth', 'show', '--status']));
ipcMain.handle('list-groups', async () => { const result = await listSessions(); return { ...result, groups: result.groups.map((group: CachedGroup) => ({ id: group.chatId, name: group.name, lastTime: group.lastTime })) }; });
ipcMain.handle('get-settings', async () => loadSettings());
ipcMain.handle('save-schedule', async (_event, input: { enabled: boolean; channel?: ScheduleChannel; groupIds: string[]; groupNames: string[]; customerChatIds?: string[]; intervalMinutes: number; message: string }) => {
  if (input.channel === 'groupmsg') {
    if (input.enabled && !groupMessageStore?.credentials()) return { ok: false, stderr: '请先完成客户群群发配置（企业 ID、Secret、发送人）' };
    if (input.enabled && !input.customerChatIds?.length) return { ok: false, stderr: '请先选择至少一个客户群' };
    const settings: ScheduleSettings = { ...loadSettings(), enabled: input.enabled, channel: 'groupmsg', customerChatIds: input.customerChatIds ?? [], intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 60), message: input.message };
    saveSettings(settings); if (settings.enabled) startSchedule(); else stopSchedule(); return { ok: true, settings };
  }
  const sessions = await listSessions(); const targets = sessions.groups.filter((group: CachedGroup) => input.groupIds.includes(group.chatId || ''));
  if (input.enabled && targets.length !== input.groupIds.length) return { ok: false, stderr: '部分目标群聊已不在当前可发送会话列表中，请刷新后重选' };
  const previous = loadSettings(); const settings: ScheduleSettings = { ...previous, enabled: input.enabled, channel: 'bot', groupNames: input.groupNames, chatIds: targets.map(target => target.chatId!).filter(Boolean), intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 60), message: input.message };
  saveSettings(settings); if (settings.enabled) startSchedule(); else stopSchedule(); return { ok: true, settings };
});
ipcMain.handle('auth-start', async () => {
  const qrcode = join(app.getPath('userData'), 'travelbot-auth.png');
  if (authProcess && !authProcess.killed) return { ok: true, pending: true, stdout: '授权流程已在等待扫码', stderr: '', qrcode: existsSync(qrcode) ? qrcode : null };
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
  return { ok: true, pending: true, stdout: '二维码已生成，等待扫码确认', stderr: '', qrcode };
});
ipcMain.handle('send-test', async (_event, content: string, groupIds: string[]) => {
  const sessions = await listSessions();
  const targets = sessions.groups.filter((group: CachedGroup) => groupIds.includes(group.chatId || ''));
  if (targets.length !== groupIds.length) return { ok: false, step: 'sessions', stderr: '部分目标群聊已不在当前可发送会话列表中，请刷新后重选。' };
  for (const target of targets) { const result = await sendToChat(target.chatId!, content); if (!result.ok) return { ...result, stderr: `${target.name}：${result.stderr || '发送失败'}` }; }
  return { ok: true, stdout: `已发送到 ${targets.length} 个群聊`, stderr: '' };
});
ipcMain.handle('groupmsg-get-config', async () => groupMessageStore?.getConfigView());
ipcMain.handle('groupmsg-save-config', async (_event, input: GroupMessageConfigInput) => {
  if (!groupMessageStore) return { ok: false, stderr: '群发模块尚未初始化' };
  try { const config = groupMessageStore.saveConfig(input); customerGroupApi?.reset(); return { ok: true, config }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '保存配置失败' }; }
});
ipcMain.handle('groupmsg-list-groups', async () => {
  if (!groupMessageStore || !customerGroupApi) return { ok: false, stderr: '群发模块尚未初始化', groups: [] };
  const sender = groupMessageStore.senderUserId();
  if (!sender) return { ok: false, stderr: '请先配置发送人 userid', groups: [] };
  // 群发任务只能发到发送人作为群主的客户群，因此按群主过滤
  try { return { ok: true, groups: await customerGroupApi.listCustomerGroups([sender]) }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '客户群列表加载失败', groups: [] }; }
});
ipcMain.handle('groupmsg-send', async (_event, input: { chatIds: string[]; content: string }) => sendGroupMessage(input.chatIds, input.content, 'manual'));
ipcMain.handle('groupmsg-history', async () => groupMessageStore?.listHistory() ?? []);
ipcMain.handle('groupmsg-result', async (_event, msgid: string) => {
  if (!customerGroupApi) return { ok: false, stderr: '群发模块尚未初始化' };
  try { return { ok: true, result: await customerGroupApi.getGroupMessageResult(msgid) }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '查询群发结果失败' }; }
});
ipcMain.handle('daily-get', async () => dailyPushStore?.view());
ipcMain.handle('daily-save', async (_event, input: DailyPushSettings) => {
  if (!dailyPushStore) return { ok: false, stderr: '每日推送模块尚未初始化' };
  if (!parseSendTime(input.sendTime)) return { ok: false, stderr: '发送时间格式应为 HH:mm，例如 17:50' };
  const ownerUserIds = [...new Set(input.ownerUserIds.map(id => id.trim()).filter(Boolean))];
  const targets = input.targets.filter(target => target.chatId && target.owner);
  if (input.enabled) {
    if (!groupMessageStore?.credentials()) return { ok: false, stderr: '请先在“客户群群发”中配置企业 ID 和 Secret' };
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
  if (input.enabled && !input.dryRun && !groupMessageStore?.credentials()) return { ok: false, stderr: '请先在“客户群群发”中配置企业 ID 和 Secret，或先开启干跑模式' };
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
  if (!itineraryStore.settings().dryRun && !groupMessageStore?.credentials()) return { ok: false, message: '请先在“客户群群发”中配置企业 ID 和 Secret，或开启干跑模式' };
  return { ...(await itineraryRunner.runJob(jobId)), view: itineraryStore.view() };
});
ipcMain.handle('itinerary-check-confirmations', async () => {
  if (!itineraryRunner || !itineraryStore) return { ok: false, stderr: '行程模块尚未初始化' };
  try { const confirmed = await itineraryRunner.checkConfirmations(new Date(), true); return { ok: true, confirmed, view: itineraryStore.view() }; }
  catch (error: any) { return { ok: false, stderr: error?.message || '查询确认状态失败' }; }
});
ipcMain.handle('open-image', async (_event, path: string) => { await shell.openPath(path); return true; });
ipcMain.handle('weather-preview', async (_event, location: string) => {
  try {
    const snapshot = await weatherProvider.getCurrent(location);
    return { ok: true, greeting: createWeatherGreeting(snapshot) };
  } catch (error: any) {
    return { ok: false, stderr: error?.message || '天气获取失败' };
  }
});
ipcMain.handle('get-weather-job', async () => travelDatabase?.getWeatherJob() ?? { id: 'default', location: '', chatIds: [], intervalMinutes: 60, enabled: false });
ipcMain.handle('save-weather-job', async (_event, input: Omit<WeatherJobSettings, 'id' | 'lastSentAt' | 'lastResult'>) => {
  if (!travelDatabase) return { ok: false, stderr: '本地数据库尚未初始化' };
  const job = travelDatabase.saveWeatherJob(input);
  startWeatherSchedule();
  return { ok: true, job };
});
ipcMain.handle('run-weather-job', async () => runWeatherJob());
ipcMain.handle('content-search', async (_event, input: { query: string; kind?: ContentKind }) => {
  if (!travelDatabase) return { ok: false, stderr: '本地数据库尚未初始化', items: [] };
  return { ok: true, items: travelDatabase.searchContent(input.query, input.kind) };
});
ipcMain.handle('content-command', async (_event, text: string) => {
  if (!travelDatabase) return { ok: false, stderr: '本地数据库尚未初始化' };
  const command = parseNaturalLanguage(text);
  if (command.intent === 'search') return { ok: true, command, items: travelDatabase.searchContent(command.query) };
  return { ok: true, command, requiresConfirmation: command.intent !== 'unknown' };
});
ipcMain.handle('content-confirm', async (_event, input: { command: NaturalLanguageCommand; confirmed: boolean }) => {
  if (!travelDatabase) return { ok: false, stderr: '本地数据库尚未初始化' };
  if (!input.confirmed) return { ok: false, cancelled: true, stderr: '操作已取消' };
  const command = input.command;
  if (command.intent === 'create') return { ok: true, item: travelDatabase.createContent({ kind: command.kind, title: command.title, body: command.body }) };
  if (command.intent === 'delete' || command.intent === 'update') {
    const matches = travelDatabase.searchContent(command.query);
    if (matches.length !== 1) return { ok: false, stderr: matches.length ? '匹配到多条内容，请提供更明确的标题' : '没有找到对应内容' };
    const item = matches[0];
    if (command.intent === 'delete') return { ok: travelDatabase.deleteContent(item.id), deletedId: item.id };
    return { ok: true, item: travelDatabase.updateContent(item.id, { body: command.body }) };
  }
  return { ok: false, stderr: '该命令不需要确认或暂不支持' };
});

app.whenReady().then(() => { travelDatabase = new TravelDatabase(join(app.getPath('userData'), 'travelbot.sqlite')); groupMessageStore = new GroupMessageStore(app.getPath('userData')); const store = groupMessageStore; customerGroupApi = new WeComCustomerGroupApi(() => store.credentials()); const api = customerGroupApi; const database = travelDatabase; dailyPushStore = new DailyPushStore(app.getPath('userData')); dailyPushRunner = new DailyPushRunner(dailyPushStore, { getForecast: (location, offset) => weatherProvider.getDailyForecast(location, offset), formatForecast, listRecommendations: () => database.listContentForRotation(), createGroupMessage: input => api.createGroupMessage(input), addHistory: record => store.addHistory(record) }); itineraryStore = new ItineraryStore(app.getPath('userData')); itineraryRunner = new ItineraryRunner(itineraryStore, { getForecast: (location, date) => weatherProvider.getForecastForDate(location, date), formatForecast, listCustomerGroups: owners => api.listCustomerGroups(owners), createGroupMessage: input => api.createGroupMessage(input), getGroupMessageResult: msgid => api.getGroupMessageResult(msgid), addHistory: record => store.addHistory(record) }); createWindow(); tray = new Tray(nativeImage.createEmpty()); tray.setToolTip('TravelBot'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 TravelBot', click: () => { mainWindow?.show(); mainWindow?.focus(); } }, { label: '退出', click: () => { quitting = true; app.quit(); } }])); tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); }); startSchedule(); startWeatherSchedule(); startDailyPush(); startItinerary(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('before-quit', () => { if (dailyPushTimer) clearInterval(dailyPushTimer); if (itineraryTimer) clearInterval(itineraryTimer); stopWeatherSchedule(); travelDatabase?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
