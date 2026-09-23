import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from 'electron';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
let authProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let quitting = false;
let scheduleTimer: NodeJS.Timeout | null = null;
let scheduleSending = false;
type ScheduleSettings = { enabled: boolean; groupNames: string[]; chatIds: string[]; intervalMinutes: number; message: string; lastRun?: string; lastResult?: string };
type CachedGroup = { name: string; lastTime?: string; chatId?: string };
const defaultSettings: ScheduleSettings = { enabled: false, groupNames: [], chatIds: [], intervalMinutes: 60, message: 'TravelBot 定时通知', lastResult: '未启动' };
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
function stopSchedule() { if (scheduleTimer) clearInterval(scheduleTimer); scheduleTimer = null; }
function startSchedule() { stopSchedule(); const settings = loadSettings(); if (!settings.enabled || !settings.chatIds.length) return; scheduleTimer = setInterval(async () => { if (scheduleSending) return; scheduleSending = true; try { const current = loadSettings(); let sent = 0; let failure = ''; for (const chatId of current.chatIds) { const result = await sendToChat(chatId, current.message); if (result.ok) sent += 1; else { failure = result.stderr || '发送失败'; break; } } current.lastRun = new Date().toISOString(); current.lastResult = failure || `发送成功（${sent}/${current.chatIds.length} 个群聊）`; saveSettings(current); } finally { scheduleSending = false; } }, Math.max(1, settings.intervalMinutes) * 60 * 1000); }

function cliInvocation(args: string[]) {
  const unpackedBinary = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@wecom', 'cli-win32-x64', 'bin', 'wecom-cli.exe');
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
  mainWindow = new BrowserWindow({ width: 1120, height: 760, minWidth: 860, minHeight: 620, backgroundColor: '#08111f', webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'));
}

ipcMain.handle('auth-status', async () => runCli(['auth', 'show', '--status']));
ipcMain.handle('list-groups', async () => { const result = await listSessions(); return { ...result, groups: result.groups.map((group: CachedGroup) => ({ id: group.chatId, name: group.name, lastTime: group.lastTime })) }; });
ipcMain.handle('get-settings', async () => loadSettings());
ipcMain.handle('save-schedule', async (_event, input: { enabled: boolean; groupIds: string[]; groupNames: string[]; intervalMinutes: number; message: string }) => {
  const sessions = await listSessions(); const targets = sessions.groups.filter((group: CachedGroup) => input.groupIds.includes(group.chatId || ''));
  if (input.enabled && targets.length !== input.groupIds.length) return { ok: false, stderr: '部分目标群聊已不在当前可发送会话列表中，请刷新后重选' };
  const previous = loadSettings(); const settings: ScheduleSettings = { ...previous, enabled: input.enabled, groupNames: input.groupNames, chatIds: targets.map(target => target.chatId!).filter(Boolean), intervalMinutes: Math.max(1, Number(input.intervalMinutes) || 60), message: input.message };
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
ipcMain.handle('open-image', async (_event, path: string) => { await shell.openPath(path); return true; });

app.whenReady().then(() => { createWindow(); tray = new Tray(nativeImage.createEmpty()); tray.setToolTip('TravelBot'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 TravelBot', click: () => { mainWindow?.show(); mainWindow?.focus(); } }, { label: '退出', click: () => { quitting = true; app.quit(); } }])); tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); }); startSchedule(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
