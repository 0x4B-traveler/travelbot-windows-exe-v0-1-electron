import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RPA_CLIENT_LABELS, type RpaClient, type RpaSettings } from '../../src/domain/ops';
import type { DesktopRpaGateway } from '../application/ports';
import { ClientLocked } from '../application/rpa-executor';

// RPA 适配器：用 PowerShell 调 Win32 接口，把本机的企业微信 / 微信客户端切到前台，
// Ctrl+F 搜索群名 → 回车进入群聊 → 粘贴内容 → 按发送键 → 逐张粘贴图片发送。全程通过剪贴板输入，结束后恢复剪贴板。
// 每一步按键前都会确认前台窗口仍是客户端，被切走就立即停止，避免把内容打到别的窗口里。
// 防封：每一步等待都带随机抖动，图片之间随机停几秒，节奏接近真人操作。
// 防发错群：进群后截取窗口顶部的聊天标题，用 Windows 自带的 OCR 识别，和群名对不上就停下、不粘贴内容。
// 防封：开始前和发完后都检查客户端有没有弹出“安全验证 / 环境异常”，有就停手，交给执行器暂停全部发送。

type ClientProfile = { processes: string[]; windows: Array<{ cls: string; title?: string }> };
const CLIENT_PROFILES: Record<RpaClient, ClientProfile> = {
  wecom: { processes: ['WXWork'], windows: [{ cls: 'WeWorkWindow' }] },
  // 微信 3.x 是 WeChatMainWndForPC；4.x（Weixin.exe）是 Qt 窗口，用标题区分
  wechat: { processes: ['Weixin', 'WeChat'], windows: [{ cls: 'WeChatMainWndForPC' }, { cls: 'mmui::MainWindow', title: '微信' }, { cls: 'Qt51514QWindowIcon', title: '微信' }] },
};

type Job = ClientProfile & { action: 'check' | 'send'; clientPath: string; searchHotkey: string; sendKeys: string; autoSend: boolean; delayMs: number; verifyChat: boolean; workDir: string; target?: string; text?: string; images?: string[] };
type ScriptResult = { ok: boolean; code: string; message: string };

export class PowerShellRpaGateway implements DesktopRpaGateway {
  /** 同一时间只能操作一次客户端，多个任务同时到点时排队执行。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: () => RpaSettings, private readonly workDir: string) {}

  async check(override?: RpaSettings): Promise<string> {
    const settings = override ?? this.settings();
    const result = await this.enqueue(() => this.run(settings, { action: 'check' }));
    const [exe, ocr] = result.message.split('|');
    if (settings.verifyChat && !ocr) throw new Error('本机没有可用的中文 OCR，无法在发送前核对群名。请在 Windows“设置 → 时间和语言 → 语言”里给中文安装“光学字符识别”，或在 RPA 设置里关闭“发送前核对群名”');
    return `已找到${RPA_CLIENT_LABELS[settings.client]}主窗口（${exe}）${settings.verifyChat ? `，发送前会用 OCR（${ocr}）核对群名` : ''}，可以使用 RPA 发送`;
  }

  async sendText(target: string, text: string, images: string[] = []): Promise<{ sent: boolean; locked?: string }> {
    const settings = this.settings();
    if (!target.trim()) throw new Error('群名称为空，RPA 无法搜索');
    const result = await this.enqueue(() => this.run(settings, { action: 'send', target: target.trim(), text, images: images.filter(path => existsSync(path)) }));
    // 已经发出去了，但发完客户端弹出安全验证：本条算成功（避免重发），由执行器暂停后续发送
    return { sent: settings.autoSend, locked: result.code === 'SENT_LOCKED' ? describe('SECURITY_CHECK', result.message, RPA_CLIENT_LABELS[settings.client]) : undefined };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(settings: RpaSettings, input: Pick<Job, 'action' | 'target' | 'text' | 'images'>): Promise<ScriptResult> {
    const label = RPA_CLIENT_LABELS[settings.client];
    if (process.platform !== 'win32') throw new Error('RPA 发送只能在 Windows 电脑上运行');
    mkdirSync(this.workDir, { recursive: true });
    const scriptPath = join(this.workDir, 'wechat-rpa.ps1');
    // 带 BOM 写入，Windows PowerShell 5.1 才会按 UTF-8 读取
    writeFileSync(scriptPath, '﻿' + RPA_SCRIPT, 'utf8');
    const jobPath = join(this.workDir, `job-${randomUUID()}.json`);
    const job: Job = {
      ...CLIENT_PROFILES[settings.client], ...input,
      clientPath: settings.clientPath.trim(),
      searchHotkey: settings.searchHotkey.trim() || '^f',
      sendKeys: settings.sendKey === 'ctrlEnter' ? '^{ENTER}' : '{ENTER}',
      autoSend: settings.autoSend,
      verifyChat: settings.verifyChat,
      workDir: this.workDir,
      delayMs: Math.min(5000, Math.max(200, Math.round(settings.stepDelayMs) || 800)),
    };
    writeFileSync(jobPath, JSON.stringify(job), 'utf8');
    try {
      const timeout = 90000 + (input.images?.length ?? 0) * 20000;
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, jobPath], { windowsHide: true, timeout, encoding: 'utf8' }, (error, out, err) => {
          if (error && !String(out).trim()) reject(new Error((error as any).killed ? 'TIMEOUT' : (String(err).trim() || error.message)));
          else resolve(String(out));
        });
      });
      let result: ScriptResult;
      try { result = JSON.parse(stdout.trim().split(/\r?\n/).pop() || ''); } catch { throw new Error(`RPA 脚本返回了无法识别的结果：${stdout.slice(0, 200)}`); }
      if (!result.ok) throw result.code === 'SECURITY_CHECK' ? new ClientLocked(describe(result.code, result.message, label)) : new Error(describe(result.code, result.message, label));
      return result;
    } catch (error: any) {
      if (error?.message === 'TIMEOUT') throw new Error(`操作${label}超时，已停止`);
      throw error;
    } finally {
      try { unlinkSync(jobPath); } catch { /* 临时文件删不掉不影响 */ }
    }
  }
}

function describe(code: string, message: string, label: string): string {
  switch (code) {
    case 'NOT_RUNNING': return `没有找到正在运行的${label}，请先打开并登录${label}（也可以在设置里填写客户端路径，让程序自动启动）`;
    case 'NO_WINDOW': return `${label}已运行，但找不到主窗口，请确认已登录`;
    case 'WRONG_CHAT': return `进群后核对群名没通过（识别到的标题：${message || '无'}），可能搜到了别的群或群名有变化，已停止，内容没有粘贴。截图在 RPA 目录的 chat-title.png`;
    case 'SEARCH_STUCK': return `搜索群名后没能进入聊天（搜索框里还是群名），可能搜不到这个群或结果加载太慢，已停止，内容没有粘贴。截图在 RPA 目录的 chat-title.png`;
    case 'SECURITY_CHECK': return `${label}弹出了安全验证（${message || '设备环境异常'}），已停止，所有发送已暂停。请用手机${label}扫码完成验证，再到“设置”点“检测本机客户端”恢复发送`;
    case 'OCR_UNAVAILABLE': return '本机没有可用的中文 OCR，无法核对群名，已停止。可以在 RPA 设置里关闭“发送前核对群名”';
    case 'FOCUS_LOST': return `无法把${label}切到前台，或操作途中前台被切走（电脑锁屏、有弹窗或有人在操作），已停止，本次没有确认发出`;
    default: return `RPA 操作${label}失败：${message || code}`;
  }
}

// PowerShell 脚本带 BOM 写入（见 run），里面少量中文关键词能按 UTF-8 读取；要发的内容都通过 UTF-8 的 job 文件传入。
const RPA_SCRIPT = String.raw`
param([string]$JobPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Result($ok, $code, $message) {
  [Console]::Out.WriteLine((@{ ok = $ok; code = $code; message = [string]$message } | ConvertTo-Json -Compress))
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RpaWin {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public static IntPtr[] VisibleWindowsOf(uint[] pids) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, p) => { uint owner; GetWindowThreadProcessId(h, out owner); if (Array.IndexOf(pids, owner) >= 0 && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string TitleOf(IntPtr h) { var s = new System.Text.StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
}
"@
# Physical pixels for screenshots, so the OCR boxes match the screen
[RpaWin]::SetProcessDPIAware() | Out-Null

# ---------- Chat title check with the built-in Windows OCR (no network, no AI) ----------
$script:ocrEngine = $null
$script:asTask = $null
function Get-OcrEngine {
  if ($script:ocrEngine) { return $script:ocrEngine }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
    $lang = New-Object Windows.Globalization.Language('zh-Hans-CN')
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
  } catch { $script:ocrEngine = $null }
  return $script:ocrEngine
}

function Await-Op($op, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

# Keep letters and digits only: drops spaces, punctuation, emoji and member counts' brackets
function Normalize-Name($text) { return ([string]$text -replace '[^\p{L}\p{N}]', '') }

function Get-Lcs($a, $b) {
  $prev = New-Object int[] ($b.Length + 1)
  for ($i = 1; $i -le $a.Length; $i++) {
    $cur = New-Object int[] ($b.Length + 1)
    for ($j = 1; $j -le $b.Length; $j++) {
      if ($a[$i - 1] -eq $b[$j - 1]) { $cur[$j] = $prev[$j - 1] + 1 } else { $cur[$j] = [Math]::Max($prev[$j], $cur[$j - 1]) }
    }
    $prev = $cur
  }
  return $prev[$b.Length]
}

function Test-TitleMatch($target, $line) {
  $raw = ([string]$line).Trim()
  $t = Normalize-Name $target
  # The title may end with the member count, e.g. "(23)"
  $l = Normalize-Name ($raw -replace '[\(（]\s*\d+\s*[\)）]\s*$', '')
  if (-not $t -or -not $l) { return $false }
  if ($l -eq $t) { return $true }
  # Tags shown after the name (external contact / all-staff group); anything else after it is a different chat,
  # e.g. searching "Team" must not accept "Team 2"
  if ($l.StartsWith($t) -and ($l.Substring($t.Length) -match '^(微信|外部|全员)+$')) { return $true }
  # Long names are cut off with an ellipsis in the title bar
  if ($raw -match '(\.{2,}|…)$' -and $l.Length -ge 4 -and $t.StartsWith($l)) { return $true }
  # Tolerate an OCR slip of one character in a name of the same length
  if ([Math]::Abs($t.Length - $l.Length) -gt 1) { return $false }
  return ((Get-Lcs $t $l) / [Math]::Max($t.Length, $l.Length)) -ge 0.8
}

# Text lines in the chat title bar: the top strip of the window, right of the session list
function Read-ChatTitle($h, $workDir) {
  $engine = Get-OcrEngine
  if (-not $engine) { throw 'OCR_UNAVAILABLE' }
  $rect = New-Object RpaWin+RECT
  [RpaWin]::GetWindowRect($h, [ref]$rect) | Out-Null
  $scale = 1.0
  try { $dpi = [RpaWin]::GetDpiForWindow($h); if ($dpi -gt 0) { $scale = $dpi / 96.0 } } catch { }
  $width = $rect.Right - $rect.Left
  $strip = [int](72 * $scale)
  $shot = New-Object System.Drawing.Bitmap($width, $strip)
  $g = [System.Drawing.Graphics]::FromImage($shot)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $shot.Size)
  $g.Dispose()
  # Enlarge small title text for the OCR, within its size limit
  $zoom = [Math]::Min(2.0, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [double]$width)
  $big = New-Object System.Drawing.Bitmap($shot, [int]($width * $zoom), [int]($strip * $zoom))
  $shot.Dispose()
  $path = Join-Path $workDir 'chat-title.png'
  $big.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
  $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose() }
  # The search box and session list sit in the left column (under ~280 logical px); the chat title starts right of it
  $minX = 280 * $scale * $zoom
  # The search box sits in the top ~56 logical px of the left column
  $searchMaxY = 56 * $scale * $zoom
  $lines = @()
  $searchLines = @()
  foreach ($line in $result.Lines) {
    $words = @($line.Words)
    if (-not $words.Count) { continue }
    $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    $text = (($words | ForEach-Object { $_.Text }) -join '')
    if ($left -ge $minX) { $lines += $text } elseif ($top -lt $searchMaxY) { $searchLines += $text }
  }
  return @{ title = $lines; search = $searchLines }
}

# OCR of one window on screen, as a single string (lines joined by spaces)
function Read-WindowText($w, $workDir, $name) {
  $engine = Get-OcrEngine
  if (-not $engine) { return '' }
  $rect = New-Object RpaWin+RECT
  [RpaWin]::GetWindowRect($w, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
  if ($width -lt 120 -or $height -lt 80) { return '' }
  $shot = New-Object System.Drawing.Bitmap($width, $height)
  $g = [System.Drawing.Graphics]::FromImage($shot)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $shot.Size)
  $g.Dispose()
  $zoom = [Math]::Min(1.0, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [double][Math]::Max($width, $height))
  $img = New-Object System.Drawing.Bitmap($shot, [int]($width * $zoom), [int]($height * $zoom))
  $shot.Dispose()
  $path = Join-Path $workDir $name
  $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose() }
  return ((@($result.Lines) | ForEach-Object { (@($_.Words) | ForEach-Object { $_.Text }) -join '' }) -join ' ')
}

# Risk-control prompt ("device environment abnormal, scan with the phone to verify"): any other visible window of the
# client that mentions verification, or the main window showing the prompt inside it. Stops before anything else is typed
# Returns the prompt text ('' when there is none); the null-char marker means "found, no readable text"
function Find-SecurityPrompt($h, $workDir) {
  if (-not (Get-OcrEngine)) { return '' }
  # The prompt may come from a helper process of the client (same name prefix, e.g. WXWork*), not only the main one
  $pids = @([uint32](Get-WindowPid $h))
  foreach ($name in $job.processes) { foreach ($p in @(Get-Process -Name ($name + '*') -ErrorAction SilentlyContinue)) { $pids += [uint32]$p.Id } }
  foreach ($w in [RpaWin]::VisibleWindowsOf([uint32[]]$pids)) {
    if ($w -eq $h) { continue }
    $text = (([RpaWin]::TitleOf($w)) + ' ' + (Read-WindowText $w $workDir 'client-popup.png')).Trim()
    if ((Normalize-Name $text) -match '安全验证|环境异常|身份验证|扫码验证|验证身份|重新登录|登录已失效') { return $text }
  }
  if ((Normalize-Name (Read-WindowText $h $workDir 'client-window.png')) -match '设备环境异常|安全验证|扫码进行安全验证') { return '设备环境异常' }
  return ''
}

function Assert-NoSecurityPrompt($h, $workDir) {
  $text = Find-SecurityPrompt $h $workDir
  if ($text) { throw ('SECURITY_CHECK|' + $text) }
}

# After something has been sent a failure must not be reported (it would be retried and sent twice): only note the prompt
function Test-SecurityPromptAfterSend($h, $workDir) {
  try { return (Find-SecurityPrompt $h $workDir) } catch { return '' }
}

function Assert-ChatTitle($h, $target, $workDir) {
  $read = Read-ChatTitle $h $workDir
  $lines = @($read.title)
  # Opening a chat clears the search box. If it still holds the name, Enter did not open anything
  # and the focus is still in the search box, even when the chat shown happens to be the right one
  # Loose on purpose (the search box text is small and often misread): a false alarm only stops the send
  $t = Normalize-Name $target
  foreach ($line in @($read.search)) { $l = Normalize-Name $line; if ($t -and $l -and ((Get-Lcs $t $l) / $t.Length) -ge 0.7) { throw ('SEARCH_STUCK|' + ($lines -join ' / ')) } }
  foreach ($line in $lines) { if (Test-TitleMatch $target $line) { return $line } }
  throw ('WRONG_CHAT|' + ($lines -join ' / '))
}

function Find-ClientWindow($job) {
  foreach ($w in $job.windows) {
    # A plain $null would be passed to .NET as an empty string and only match untitled windows
    $title = [NullString]::Value
    if ($w.title) { $title = [string]$w.title }
    $h = [RpaWin]::FindWindow([string]$w.cls, $title)
    if ($h -ne [IntPtr]::Zero) { return $h }
  }
  foreach ($name in $job.processes) {
    foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
    }
  }
  return [IntPtr]::Zero
}

function Test-ClientRunning($job) {
  foreach ($name in $job.processes) { if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { return $true } }
  return $false
}

function Get-WindowPid($h) {
  [uint32]$windowPid = 0
  [RpaWin]::GetWindowThreadProcessId($h, [ref]$windowPid) | Out-Null
  return $windowPid
}

function Assert-Foreground($h) {
  $target = Get-WindowPid $h
  $current = Get-WindowPid ([RpaWin]::GetForegroundWindow())
  if ($target -eq 0 -or $target -ne $current) { throw 'FOCUS_LOST' }
}

function Focus-Window($h) {
  if ([RpaWin]::IsIconic($h)) { [RpaWin]::ShowWindow($h, 9) | Out-Null } else { [RpaWin]::ShowWindow($h, 5) | Out-Null }
  for ($i = 0; $i -lt 3; $i++) {
    # Pressing ALT lets a background process take the foreground (Windows foreground lock)
    [RpaWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [RpaWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [RpaWin]::BringWindowToTop($h) | Out-Null
    [RpaWin]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
    if ((Get-WindowPid $h) -eq (Get-WindowPid ([RpaWin]::GetForegroundWindow()))) { return }
  }
  throw 'FOCUS_LOST'
}

function Send-Keys($h, $keys) {
  Assert-Foreground $h
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

# Every wait gets random jitter so the rhythm is not machine-regular
function Wait-Step($factor) {
  $ms = [int]($delay * $factor * (Get-Random -Minimum 0.7 -Maximum 1.4))
  Start-Sleep -Milliseconds ([Math]::Max(80, $ms))
}

function Paste-Image($h, $path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $stream = New-Object System.IO.MemoryStream(,$bytes)
  $img = [System.Drawing.Image]::FromStream($stream)
  try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose(); $stream.Dispose() }
  Start-Sleep -Milliseconds 200
  Send-Keys $h '^v'
}

function Paste-Text($h, $text) {
  [System.Windows.Forms.Clipboard]::SetText([string]$text)
  Start-Sleep -Milliseconds 150
  Send-Keys $h '^v'
}

try {
  $job = [System.IO.File]::ReadAllText($JobPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $delay = [int]$job.delayMs
  $h = Find-ClientWindow $job
  if ($h -eq [IntPtr]::Zero -and -not (Test-ClientRunning $job) -and $job.clientPath -and (Test-Path -LiteralPath $job.clientPath)) {
    Start-Process -FilePath $job.clientPath | Out-Null
    for ($i = 0; $i -lt 30 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; $h = Find-ClientWindow $job }
  }
  if ($h -eq [IntPtr]::Zero) {
    if (Test-ClientRunning $job) { throw 'NO_WINDOW' } else { throw 'NOT_RUNNING' }
  }
  if ($job.action -eq 'check') {
    $proc = Get-Process -Id (Get-WindowPid $h) -ErrorAction SilentlyContinue
    $exe = 'window'
    if ($proc) { $exe = "$($proc.ProcessName).exe" }
    $ocr = ''
    if (Get-OcrEngine) {
      if ($job.verifyChat) { $ocr = $script:ocrEngine.RecognizerLanguage.LanguageTag }
      # The prompt is only visible on screen with the client in front
      Focus-Window $h
      Wait-Step 0.5
      Assert-NoSecurityPrompt $h ([string]$job.workDir)
    }
    Out-Result $true 'FOUND' ($exe + '|' + $ocr)
    exit 0
  }

  $saved = $null
  try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $saved = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
  try {
    Focus-Window $h
    Wait-Step 0.5
    Assert-NoSecurityPrompt $h ([string]$job.workDir)
    Send-Keys $h ([string]$job.searchHotkey)
    Wait-Step 1
    Send-Keys $h '^a'
    Paste-Text $h $job.target
    # Wait for search results to load
    Wait-Step 1.5
    # WeCom shows the results with nothing selected, so Enter alone does nothing: select the first result first
    Send-Keys $h '{DOWN}'
    Wait-Step 0.5
    Send-Keys $h '{ENTER}'
    Wait-Step 1
    # Make sure the opened chat is the target group before typing anything into it
    $title = ''
    if ($job.verifyChat) { $title = Assert-ChatTitle $h ([string]$job.target) ([string]$job.workDir) }
    Paste-Text $h $job.text
    # Like a person glancing over the text before sending
    Wait-Step 1.5
    if ($job.autoSend) {
      Send-Keys $h ([string]$job.sendKeys)
      Wait-Step 1
    }
    $locked = ''
    foreach ($path in @($job.images)) {
      if (-not $path) { continue }
      if ($job.autoSend) { $locked = Test-SecurityPromptAfterSend $h ([string]$job.workDir); if ($locked) { break } }
      # A few seconds between pictures, the way a person picks and sends them
      Start-Sleep -Milliseconds ([int](Get-Random -Minimum 2500 -Maximum 6000))
      Paste-Image $h ([string]$path)
      Wait-Step 1.5
      if ($job.autoSend) {
        Send-Keys $h ([string]$job.sendKeys)
        Wait-Step 1
      }
    }
    # The prompt can show up right after a send: note it so nothing else runs until someone verifies
    if (-not $locked) { Wait-Step 1.5; $locked = Test-SecurityPromptAfterSend $h ([string]$job.workDir) }
  } finally {
    try { if ($null -ne $saved -and $saved.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetText($saved) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch { }
  }
  if ($locked) { Out-Result $true 'SENT_LOCKED' $locked } else { Out-Result $true 'SENT' $title }
} catch {
  $message = $_.Exception.Message
  if ($message -match '^([A-Z_]+)(\|(.*))?$') { Out-Result $false $Matches[1] $Matches[3] } else { Out-Result $false 'ERROR' $message }
}
exit 0
`;
