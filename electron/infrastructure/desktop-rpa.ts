import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RPA_CLIENT_LABELS, type RpaClient, type RpaSettings } from '../../src/domain/ops';
import type { DesktopRpaGateway } from '../application/ports';

// RPA 适配器：用 PowerShell 调 Win32 接口，把本机的企业微信 / 微信客户端切到前台，
// Ctrl+F 搜索群名 → 回车进入群聊 → 粘贴内容 → 按发送键 → 逐张粘贴图片发送。全程通过剪贴板输入，结束后恢复剪贴板。
// 每一步按键前都会确认前台窗口仍是客户端，被切走就立即停止，避免把内容打到别的窗口里。
// 防封：每一步等待都带随机抖动，图片之间随机停几秒，节奏接近真人操作。

type ClientProfile = { processes: string[]; windows: Array<{ cls: string; title?: string }> };
const CLIENT_PROFILES: Record<RpaClient, ClientProfile> = {
  wecom: { processes: ['WXWork'], windows: [{ cls: 'WeWorkWindow' }] },
  // 微信 3.x 是 WeChatMainWndForPC；4.x（Weixin.exe）是 Qt 窗口，用标题区分
  wechat: { processes: ['Weixin', 'WeChat'], windows: [{ cls: 'WeChatMainWndForPC' }, { cls: 'mmui::MainWindow', title: '微信' }, { cls: 'Qt51514QWindowIcon', title: '微信' }] },
};

type Job = ClientProfile & { action: 'check' | 'send'; clientPath: string; searchHotkey: string; sendKeys: string; autoSend: boolean; delayMs: number; target?: string; text?: string; images?: string[] };
type ScriptResult = { ok: boolean; code: string; message: string };

export class PowerShellRpaGateway implements DesktopRpaGateway {
  /** 同一时间只能操作一次客户端，多个任务同时到点时排队执行。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: () => RpaSettings, private readonly workDir: string) {}

  async check(override?: RpaSettings): Promise<string> {
    const settings = override ?? this.settings();
    const result = await this.enqueue(() => this.run(settings, { action: 'check' }));
    return `已找到${RPA_CLIENT_LABELS[settings.client]}主窗口（${result.message}），可以使用 RPA 发送`;
  }

  async sendText(target: string, text: string, images: string[] = []): Promise<{ sent: boolean }> {
    const settings = this.settings();
    if (!target.trim()) throw new Error('群名称为空，RPA 无法搜索');
    await this.enqueue(() => this.run(settings, { action: 'send', target: target.trim(), text, images: images.filter(path => existsSync(path)) }));
    return { sent: settings.autoSend };
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
      if (!result.ok) throw new Error(describe(result.code, result.message, label));
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
    case 'FOCUS_LOST': return `无法把${label}切到前台，或操作途中前台被切走（电脑锁屏、有弹窗或有人在操作），已停止，本次没有确认发出`;
    default: return `RPA 操作${label}失败：${message || code}`;
  }
}

// PowerShell 脚本只用 ASCII，避免编码问题；中文内容都通过 UTF-8 的 job 文件传入。
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
}
"@

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
    Out-Result $true 'FOUND' ($(if ($proc) { "$($proc.ProcessName).exe" } else { 'window' }))
    exit 0
  }

  $saved = $null
  try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $saved = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
  try {
    Focus-Window $h
    Wait-Step 0.5
    Send-Keys $h ([string]$job.searchHotkey)
    Wait-Step 1
    Send-Keys $h '^a'
    Paste-Text $h $job.target
    # Wait for search results to load
    Wait-Step 1.5
    Send-Keys $h '{ENTER}'
    Wait-Step 1
    Paste-Text $h $job.text
    # Like a person glancing over the text before sending
    Wait-Step 1.5
    if ($job.autoSend) {
      Send-Keys $h ([string]$job.sendKeys)
      Wait-Step 1
    }
    foreach ($path in @($job.images)) {
      if (-not $path) { continue }
      # A few seconds between pictures, the way a person picks and sends them
      Start-Sleep -Milliseconds ([int](Get-Random -Minimum 2500 -Maximum 6000))
      Paste-Image $h ([string]$path)
      Wait-Step 1.5
      if ($job.autoSend) {
        Send-Keys $h ([string]$job.sendKeys)
        Wait-Step 1
      }
    }
  } finally {
    try { if ($null -ne $saved -and $saved.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetText($saved) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch { }
  }
  Out-Result $true 'SENT' ''
} catch {
  $message = $_.Exception.Message
  if ($message -match '^[A-Z_]+$') { Out-Result $false $message '' } else { Out-Result $false 'ERROR' $message }
}
exit 0
`;
