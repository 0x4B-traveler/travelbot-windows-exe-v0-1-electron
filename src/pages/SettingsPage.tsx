import React, { useEffect, useState } from 'react';
import type { GroupMessageConfigView } from '../domain/business';
import { call } from '../api';
import { RPA_CLIENT_LABELS, SEND_MODE_LABELS, type RpaClient, type RpaGuard, type RpaSettings, type SendMode, type SendSettings } from '../domain/ops';
import { Card, Field, Notice, Tabs, useAction } from '../ui';

export type ConnectionState = 'checking' | 'unauthorized' | 'authorizing' | 'authorized' | 'error';

/** 设置：企业微信机器人扫码授权、客户群发送方式（接口 / RPA）。不属于核心业务模块。 */
export function SettingsPage({ connection, onConnectionChange }: { connection: ConnectionState; onConnectionChange: (state: ConnectionState) => void }) {
  return <>
    <AuthCard state={connection} onChange={onConnectionChange} />
    <SendModeCard />
  </>;
}

/** 客户群发送方式切换：接口模式显示企业微信接口配置，RPA 模式显示桌面客户端配置。保存后立即生效。 */
function SendModeCard() {
  const [saved, setSaved] = useState<SendSettings | null>(null);
  const [mode, setMode] = useState<SendMode>('api');
  const [rpa, setRpa] = useState<RpaSettings | null>(null);
  const { busy, notice, run } = useAction();
  useEffect(() => { void call('settings.getSend').then(value => { setSaved(value); setMode(value.mode); setRpa(value.rpa); }); }, []);
  if (!saved || !rpa) return <Card title="客户群发送方式"><p className="hint">正在加载…</p></Card>;
  const patch = (next: Partial<RpaSettings>) => setRpa({ ...rpa, ...next });
  const guard = rpa.guard;
  const patchGuard = (next: Partial<RpaGuard>) => setRpa({ ...rpa, guard: { ...guard, ...next } });
  const num = (key: keyof RpaGuard) => (event: React.ChangeEvent<HTMLInputElement>) => patchGuard({ [key]: Number(event.target.value) } as Partial<RpaGuard>);
  const dirty = mode !== saved.mode || JSON.stringify(rpa) !== JSON.stringify(saved.rpa);
  const save = () => void run(async () => {
    const next = await call('settings.saveSend', { mode, rpa });
    setSaved(next); setMode(next.mode); setRpa(next.rpa);
    return next.mode === 'rpa' ? `已切换为 RPA：客户群将通过本机${RPA_CLIENT_LABELS[next.rpa.client]}发送` : '已切换为企业微信接口发送';
  });
  const label = RPA_CLIENT_LABELS[rpa.client];
  return <>
    <Card title="客户群发送方式" extra={saved.mode !== mode ? <span className="hint">未保存</span> : undefined}>
      <Tabs<SendMode> value={mode} onChange={setMode} options={(Object.keys(SEND_MODE_LABELS) as SendMode[]).map(value => ({ value, label: `${SEND_MODE_LABELS[value]}${saved.mode === value ? ' · 当前' : ''}` }))} />
      {mode === 'api'
        ? <p className="hint">通过企业微信“客户群群发”接口创建任务，群主在企业微信里确认后发出。需要配置企业 ID、Secret，并把本机公网 IP 加入企业可信 IP。机器人群不受影响，始终由机器人直接发送。</p>
        : <>
          <p className="hint">程序会自动操作本机已登录的{label}：切到前台 → 搜索群名 → 进入群聊 → 粘贴内容 → 发送。不需要接口权限和可信 IP，群可以在“群管理”里按群名手动添加。发送时会占用屏幕和剪贴板几秒钟，电脑锁屏时无法发送；群名请保持唯一，程序会进入搜索结果的第一个。</p>
          <Field label="操作哪个客户端" group><div className="radio-row">{(Object.keys(RPA_CLIENT_LABELS) as RpaClient[]).map(value => <label key={value} className="toggle-row"><input type="radio" checked={rpa.client === value} onChange={() => patch({ client: value })} />{RPA_CLIENT_LABELS[value]}</label>)}</div></Field>
          <Field label="发送方式" group><div className="radio-row">
            <label className="toggle-row"><input type="radio" checked={rpa.autoSend} onChange={() => patch({ autoSend: true })} />自动发送</label>
            <label className="toggle-row"><input type="radio" checked={!rpa.autoSend} onChange={() => patch({ autoSend: false })} />只粘贴，人工按发送（试跑用）</label>
          </div></Field>
          <div className="form-grid">
            <Field label="发送键" hint={`和${label}“设置 → 快捷键”里的发送消息保持一致`}><select value={rpa.sendKey} onChange={event => patch({ sendKey: event.target.value as RpaSettings['sendKey'] })}><option value="enter">Enter</option><option value="ctrlEnter">Ctrl + Enter</option></select></Field>
            <Field label="搜索快捷键" hint="^ 表示 Ctrl，% 表示 Alt，默认 ^f（Ctrl+F）"><input value={rpa.searchHotkey} onChange={event => patch({ searchHotkey: event.target.value })} /></Field>
            <Field label="每步等待（毫秒）" hint="电脑或网络较慢、搜索结果出来得慢时调大"><input type="number" min={200} max={5000} step={100} value={rpa.stepDelayMs} onChange={event => patch({ stepDelayMs: Number(event.target.value) })} /></Field>
            <Field label="客户端路径（可选）" hint={`${label}没打开时自动启动，例如 C:\\Program Files\\…\\${rpa.client === 'wecom' ? 'WXWork.exe' : 'Weixin.exe'}`}><input value={rpa.clientPath} onChange={event => patch({ clientPath: event.target.value })} placeholder="留空则需要手动打开客户端" /></Field>
            <Field label="每次附带攻略图（张）" hint="取内容关联路线里素材的图片，0 表示只发文字"><input type="number" min={0} max={9} value={guard.maxImages} onChange={num('maxImages')} /></Field>
          </div>
          <h4 className="sub-title">防封设置</h4>
          <p className="hint">按真人的节奏发：每一步操作都带随机停顿，群与群之间随机间隔；限制每小时、每天和单群的发送次数；只在白天时段发，时段外到点的任务自动顺延；连续失败会自动暂停，避免客户端掉线或弹验证时还在反复操作。</p>
          <div className="form-grid">
            <Field label="群与群间隔（秒）" hint="每发完一个群随机等待这么久再发下一个">
              <div className="inline-actions"><input type="number" min={0} max={600} value={guard.groupGapMinSec} onChange={num('groupGapMinSec')} /><span>到</span><input type="number" min={0} max={1800} value={guard.groupGapMaxSec} onChange={num('groupGapMaxSec')} /></div>
            </Field>
            <Field label="发送时段" hint="时段外到点的任务顺延到下一个时段开始">
              <div className="inline-actions"><input type="time" value={guard.activeStart} onChange={event => patchGuard({ activeStart: event.target.value })} /><span>到</span><input type="time" value={guard.activeEnd} onChange={event => patchGuard({ activeEnd: event.target.value })} /></div>
            </Field>
            <Field label="每小时最多（次）" hint="发到一个群算一次，0 表示不限"><input type="number" min={0} value={guard.maxPerHour} onChange={num('maxPerHour')} /></Field>
            <Field label="每天最多（次）" hint="0 表示不限"><input type="number" min={0} value={guard.maxPerDay} onChange={num('maxPerDay')} /></Field>
            <Field label="单群每天最多（次）" hint="防止重复任务把同一个群刷屏"><input type="number" min={0} value={guard.maxPerGroupPerDay} onChange={num('maxPerGroupPerDay')} /></Field>
            <Field label="连续失败暂停" hint="连续失败几次后暂停多少分钟，0 次表示不暂停">
              <div className="inline-actions"><input type="number" min={0} max={20} value={guard.pauseAfterFailures} onChange={num('pauseAfterFailures')} /><span>次 → 暂停</span><input type="number" min={1} value={guard.pauseMinutes} onChange={num('pauseMinutes')} /><span>分钟</span></div>
            </Field>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={guard.varyOpening} onChange={event => patchGuard({ varyOpening: event.target.checked })} />开头随机加一句问候（如“大家早上好！”），让多个群收到的文字不完全一样</label>
        </>}
      <Notice notice={notice} />
      <div className="actions">
        {mode === 'rpa' && <button className="secondary" disabled={busy} onClick={() => void run(() => call('settings.checkRpa', { rpa }))}>检测客户端</button>}
        <button className="primary" disabled={busy || !dirty} onClick={save}>{saved.mode !== mode ? `切换为${SEND_MODE_LABELS[mode]}` : '保存'}</button>
      </div>
    </Card>
    {mode === 'api' && <GroupMessageConfigCard />}
  </>;
}

export async function checkAuth(): Promise<{ state: ConnectionState; detail: string }> {
  const result = await window.travelbot.authStatus();
  if (result.ok && result.stdout?.trim().toLowerCase() === 'authorized') return { state: 'authorized', detail: '企业微信机器人已授权' };
  return { state: result.ok ? 'unauthorized' : 'error', detail: result.ok ? '尚未授权，请扫码绑定企业微信' : (result.stderr || '授权状态检查失败') };
}

function AuthCard({ state, onChange }: { state: ConnectionState; onChange: (state: ConnectionState) => void }) {
  const [detail, setDetail] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const check = async () => { const result = await checkAuth(); if (state !== 'authorizing' || result.state === 'authorized') { onChange(result.state); setDetail(result.detail); } };
  useEffect(() => { void check(); }, []);
  useEffect(() => {
    if (state !== 'authorizing') return;
    const timer = window.setInterval(() => { void check(); }, 2500);
    return () => window.clearInterval(timer);
  }, [state]);
  const authorize = async () => {
    onChange('authorizing'); setDetail('正在生成二维码，扫码后请在企业微信中确认（最多等待 5 分钟）'); setQr(null); setQrSrc(null);
    const result = await window.travelbot.startAuth();
    if (result.qrcode) setQr(result.qrcode);
    if (result.qrcodeDataUrl) setQrSrc(result.qrcodeDataUrl);
    if (result.ok && result.pending) setDetail('二维码已生成，请立即使用企业微信扫码并确认');
    else if (result.ok) { onChange('authorized'); setDetail('连接成功！企业微信授权已保存到本机'); }
    else { onChange('error'); setDetail(result.stderr || '授权未完成'); }
  };
  const connected = state === 'authorized';
  return <Card title="企业微信机器人" extra={<button className="refresh-button" onClick={() => void check()} disabled={state === 'authorizing'} title="刷新连接状态"><span>↻</span></button>}>
    <div className="connection"><div className={`icon ${connected ? 'authorized' : state}`}><span>{connected ? '✓' : '↗'}</span></div><div><strong>{connected ? '企业微信已连接' : state === 'checking' ? '正在检查…' : '等待企业微信授权'}</strong><p>{detail}</p></div></div>
    {qr && state === 'authorizing' && <div className="qr-box">{qrSrc ? <img src={qrSrc} alt="企业微信授权二维码" /> : <p className="hint">二维码预览加载失败，请点右侧在系统中打开</p>}<button className="link" onClick={() => void window.travelbot.openImage(qr)}>在系统中打开二维码</button></div>}
    <p className="hint">授权后，“群管理”里刷新就能看到机器人所在的群。把机器人拉进群并在群里给它发一条消息，群才会出现在列表里。</p>
    <div className="actions"><button className="primary" onClick={() => void authorize()} disabled={state === 'authorizing'}>{connected ? '重新扫码授权' : '扫码授权'}</button></div>
  </Card>;
}

function GroupMessageConfigCard() {
  const [config, setConfig] = useState<GroupMessageConfigView | null>(null);
  const [corpId, setCorpId] = useState('');
  const [senderUserId, setSenderUserId] = useState('');
  const [secret, setSecret] = useState('');
  const { busy, notice, run } = useAction();
  useEffect(() => { void window.travelbot.groupMessageConfig().then(view => { setConfig(view); setCorpId(view.corpId); setSenderUserId(view.senderUserId); }); }, []);
  return <Card title="客户群群发">
    <p className="hint">用于向客户群发送：通过企业微信“客户群群发”接口创建任务，群主在企业微信里确认后发出。运行本程序的电脑公网 IP 需加入该自建应用的“企业可信 IP”。</p>
    <div className="form-grid">
      <Field label="企业 ID（corpid）"><input value={corpId} onChange={event => setCorpId(event.target.value)} /></Field>
      <Field label="发送人 userid（群主）"><input value={senderUserId} onChange={event => setSenderUserId(event.target.value)} /></Field>
    </div>
    <Field label="自建应用 Secret" hint="应用管理 → 自建应用 → Secret；并在“客户联系 → 可调用接口的应用”里勾选这个应用"><input type="password" value={secret} placeholder={config?.hasSecret ? '已保存，留空则不修改' : '在管理后台“应用管理 → 自建应用”中获取'} onChange={event => setSecret(event.target.value)} autoComplete="off" /></Field>
    {config && !config.encryptionAvailable && <p className="notice error">当前系统不支持加密存储，无法保存 Secret。</p>}
    <Notice notice={notice} />
    <div className="actions"><button className="primary" disabled={busy || !corpId.trim() || !senderUserId.trim() || (!secret.trim() && !config?.hasSecret)} onClick={() => void run(async () => {
      const result = await window.travelbot.saveGroupMessageConfig({ corpId, senderUserId, secret });
      if (!result.ok || !result.config) throw new Error(result.stderr || '保存失败');
      setConfig(result.config); setSecret('');
      return '配置已保存，Secret 已加密存储在本机。到“群管理”刷新即可加载客户群。';
    })}>保存配置</button></div>
  </Card>;
}
