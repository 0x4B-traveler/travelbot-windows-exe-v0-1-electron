import React, { useEffect, useState } from 'react';
import type { GroupMessageConfigView } from '../domain/business';
import { call } from '../api';
import { DEFAULT_AGENT_PORT, POOL_ROLE_LABELS, RPA_CLIENT_LABELS, type AccountStatus, type PoolRole, type PoolSettings, type RpaAccount, type RpaClient, type RpaGuard, type RpaSettings, type SendSettings } from '../domain/ops';
import { Card, Field, Notice, useAction } from '../ui';
import { EDITION } from '../edition';

export type ConnectionState = 'checking' | 'unauthorized' | 'authorizing' | 'authorized' | 'error';

/** 设置：企业微信机器人扫码授权、客户群发送方式（接口 / RPA）。不属于核心业务模块。 */
export function SettingsPage({ connection, onConnectionChange }: { connection: ConnectionState; onConnectionChange: (state: ConnectionState) => void }) {
  return <>
    <AuthCard state={connection} onChange={onConnectionChange} />
    {EDITION === 'rpa' ? <SendModeCard /> : <GroupMessageConfigCard />}
  </>;
}

/** RPA 版的客户群发送设置：桌面客户端、防封规则、账号池。接口版显示企业微信接口配置。保存后立即生效。 */
function SendModeCard() {
  const [saved, setSaved] = useState<SendSettings | null>(null);
  const [rpa, setRpa] = useState<RpaSettings | null>(null);
  const [pool, setPool] = useState<PoolSettings | null>(null);
  const [agent, setAgent] = useState<Awaited<ReturnType<typeof loadAgent>> | null>(null);
  const { busy, notice, run } = useAction();
  const apply = (value: SendSettings) => { setSaved(value); setRpa(value.rpa); setPool(value.pool); };
  useEffect(() => { void call('settings.getSend').then(apply); void loadAgent().then(setAgent); }, []);
  if (!saved || !rpa || !pool) return <Card title="客户群发送方式"><p className="hint">正在加载…</p></Card>;
  const patch = (next: Partial<RpaSettings>) => setRpa({ ...rpa, ...next });
  const guard = rpa.guard;
  const patchGuard = (next: Partial<RpaGuard>) => setRpa({ ...rpa, guard: { ...guard, ...next } });
  const num = (key: keyof RpaGuard) => (event: React.ChangeEvent<HTMLInputElement>) => patchGuard({ [key]: Number(event.target.value) } as Partial<RpaGuard>);
  const dirty = JSON.stringify(rpa) !== JSON.stringify(saved.rpa) || JSON.stringify(pool) !== JSON.stringify(saved.pool);
  const save = () => void run(async () => {
    const next = await call('settings.saveSend', { mode: saved.mode, rpa, pool });
    apply(next);
    // 执行端的局域网服务是异步启动的，稍等再读状态
    window.setTimeout(() => void loadAgent().then(setAgent), 800);
    return next.pool.role === 'agent' ? '已保存：本机作为执行端，等待主控发来的发送指令' : `已保存：客户群按账号池发送（${next.pool.accounts.filter(account => account.enabled).length} 个可用账号）`;
  });
  const isAgent = pool.role === 'agent';
  const label = RPA_CLIENT_LABELS[rpa.client];
  return <>
    <Card title="客户群发送（RPA）">
          <p className="hint">程序会自动操作已登录的{label}：切到前台 → 搜索群名 → 进入群聊 → 粘贴内容 → 发送。不需要接口权限和可信 IP，群可以在“群管理”里按群名手动添加。发送时会占用屏幕和剪贴板几秒钟，电脑锁屏时无法发送；群名请保持唯一，程序会进入搜索结果的第一个。</p>
          <Field label="本机角色" group hint="一个企业微信账号只能稳定登录一台电脑，多个账号就用多台电脑：一台主控管内容、任务和群，其他电脑做执行端，各自用自己的账号发。"><div className="radio-row">{(Object.keys(POOL_ROLE_LABELS) as PoolRole[]).map(value => <label key={value} className="toggle-row"><input type="radio" checked={pool.role === value} onChange={() => setPool({ ...pool, role: value })} />{POOL_ROLE_LABELS[value]}{value === 'master' ? '（管内容、任务和群）' : '（只接收主控的发送指令）'}</label>)}</div></Field>
          {isAgent && <div className="preview-box">
            <p><strong>在主控的“账号池”里添加本机时填写：</strong></p>
            <p>IP 地址：<span className="mono">{agent?.addresses.join(' / ') || '未获取到局域网地址'}</span></p>
            <div className="form-grid">
              <Field label="端口"><input type="number" min={1025} max={65535} value={pool.agentPort} onChange={event => setPool({ ...pool, agentPort: Number(event.target.value) || DEFAULT_AGENT_PORT })} /></Field>
              <Field label="配对口令" hint="保存后自动生成，主控需要填同样的口令"><input value={pool.agentToken} onChange={event => setPool({ ...pool, agentToken: event.target.value })} placeholder="保存后自动生成" /></Field>
            </div>
            <p className="hint">{saved.pool.role !== 'agent' ? '保存后开始监听。' : agent?.listening ? `正在监听端口 ${agent.port}，等待主控的指令。第一次启动时 Windows 防火墙可能会询问，请选择“允许”。` : `没有在监听：${agent?.error || '请保存后重试'}`}本机的客户端和下面的防封设置只对本机账号生效。</p>
          </div>}
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
          <label className="toggle-row"><input type="checkbox" checked={rpa.verifyChat} onChange={event => patch({ verifyChat: event.target.checked })} />发送前核对群名（用 Windows 自带 OCR 识别聊天标题，对不上就不发）</label>
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
          {!isAgent && <AccountPool pool={pool} onChange={setPool} />}

      <Notice notice={notice} />
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(() => call('settings.checkRpa', { rpa }))}>检测本机客户端</button>
        <button className="primary" disabled={busy || !dirty} onClick={save}>保存</button>
      </div>
    </Card>
  </>;
}

const loadAgent = () => call('settings.agentInfo');

/** 账号池（主控）：本机账号 + 局域网里的执行端。群在“群管理”里绑定账号，没绑定的用第一个可用账号。 */
function AccountPool({ pool, onChange }: { pool: PoolSettings; onChange: (next: PoolSettings) => void }) {
  const [draft, setDraft] = useState({ name: '', host: '', port: DEFAULT_AGENT_PORT, token: '' });
  const [status, setStatus] = useState<Record<string, AccountStatus | 'checking'>>({});
  const update = (id: string, patch: Partial<RpaAccount>) => onChange({ ...pool, accounts: pool.accounts.map(account => account.id === id ? { ...account, ...patch } : account) });
  const test = async (account: RpaAccount) => {
    setStatus(current => ({ ...current, [account.id]: 'checking' }));
    const result = await call('settings.checkAccount', { account }).catch((error: unknown): AccountStatus => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    setStatus(current => ({ ...current, [account.id]: result }));
  };
  const add = () => {
    const id = `acc-${Date.now().toString(36)}`;
    onChange({ ...pool, accounts: [...pool.accounts, { id, name: draft.name.trim() || `账号 ${pool.accounts.length + 1}`, kind: 'remote', host: draft.host.trim(), port: draft.port || DEFAULT_AGENT_PORT, token: draft.token.trim(), enabled: true }] });
    setDraft({ name: '', host: '', port: DEFAULT_AGENT_PORT, token: '' });
  };
  return <>
    <h4 className="sub-title">账号池</h4>
    <p className="hint">每个账号对应一台登录了企业微信的电脑。其他电脑装好本程序、在“本机角色”选执行端，再把它显示的 IP、端口和口令填到这里。防封限频由每台执行端按自己的账号计算。</p>
    <table className="ops-table">
      <thead><tr><th>账号</th><th>位置</th><th>状态</th><th></th></tr></thead>
      <tbody>{pool.accounts.map(account => {
        const state = status[account.id];
        return <tr key={account.id}>
          <td><input value={account.name} onChange={event => update(account.id, { name: event.target.value })} /></td>
          <td className="mono">{account.kind === 'local' ? '本机' : `${account.host}:${account.port}`}</td>
          <td>{state === 'checking' ? '检测中…' : state ? <span className={state.ok ? '' : 'danger-text'}>{state.detail}{state.sentToday !== undefined ? `（今日已发 ${state.sentToday}）` : ''}</span> : account.enabled ? '启用' : '停用'}</td>
          <td className="actions-cell">
            <button className="link" onClick={() => void test(account)}>测试</button>
            <button className="link" onClick={() => update(account.id, { enabled: !account.enabled })}>{account.enabled ? '停用' : '启用'}</button>
            {account.kind === 'remote' && <button className="link" onClick={() => onChange({ ...pool, accounts: pool.accounts.filter(item => item.id !== account.id) })}>删除</button>}
          </td>
        </tr>;
      })}</tbody>
    </table>
    <div className="form-grid">
      <Field label="新账号名称"><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="如：小王的企业微信" /></Field>
      <Field label="执行端 IP"><input value={draft.host} onChange={event => setDraft({ ...draft, host: event.target.value })} placeholder="如 192.168.1.23" /></Field>
      <Field label="端口"><input type="number" value={draft.port} onChange={event => setDraft({ ...draft, port: Number(event.target.value) })} /></Field>
      <Field label="配对口令"><input value={draft.token} onChange={event => setDraft({ ...draft, token: event.target.value })} /></Field>
    </div>
    <div className="inline-actions"><button className="secondary" disabled={!draft.host.trim() || !draft.token.trim()} onClick={add}>添加到账号池</button><span className="hint">添加后点“保存”生效</span></div>
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
