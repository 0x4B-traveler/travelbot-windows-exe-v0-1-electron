import React, { useEffect, useState } from 'react';
import { call } from '../api';
import { DEFAULT_AGENT_PORT, DEFAULT_RPA_GUARD, POOL_ROLE_LABELS, RPA_CLIENT_LABELS, type AccountStatus, type MailSettingsView, type PoolRole, type PoolSettings, type RpaAccount, type RpaClient, type RpaGuard, type RpaSettings, type SendSettings } from '../domain/ops';
import { Card, Field, Notice, useAction } from '../ui';

/** 设置：RPA 发送（桌面客户端、发送时段、账号池），保存后立即生效；防封规则内置，只展示不可改。不属于核心业务模块。 */
export function SettingsPage() {
  const [saved, setSaved] = useState<SendSettings | null>(null);
  const [rpa, setRpa] = useState<RpaSettings | null>(null);
  const [pool, setPool] = useState<PoolSettings | null>(null);
  const [agent, setAgent] = useState<Awaited<ReturnType<typeof loadAgent>> | null>(null);
  const { busy, notice, run } = useAction();
  const apply = (value: SendSettings) => { setSaved(value); setRpa(value.rpa); setPool(value.pool); };
  useEffect(() => { void call('settings.getSend').then(apply); void loadAgent().then(setAgent); }, []);
  if (!saved || !rpa || !pool) return <Card title="RPA 发送"><p className="hint">正在加载…</p></Card>;
  const patch = (next: Partial<RpaSettings>) => setRpa({ ...rpa, ...next });
  const guard = rpa.guard;
  const patchGuard = (next: Partial<RpaGuard>) => setRpa({ ...rpa, guard: { ...guard, ...next } });
  const num = (key: keyof RpaGuard) => (event: React.ChangeEvent<HTMLInputElement>) => patchGuard({ [key]: Number(event.target.value) } as Partial<RpaGuard>);
  const dirty = JSON.stringify(rpa) !== JSON.stringify(saved.rpa) || JSON.stringify(pool) !== JSON.stringify(saved.pool);
  const save = () => void run(async () => {
    const next = await call('settings.saveSend', { rpa, pool });
    apply(next);
    // 执行端的局域网服务是异步启动的，稍等再读状态
    window.setTimeout(() => void loadAgent().then(setAgent), 800);
    return next.pool.role === 'agent' ? '已保存：本机作为执行端，等待主控发来的发送指令' : `已保存：按账号池发送（${next.pool.accounts.filter(account => account.enabled).length} 个可用账号）`;
  });
  const isAgent = pool.role === 'agent';
  const label = RPA_CLIENT_LABELS[rpa.client];
  return <>
    <Card title="RPA 发送">
          <p className="hint">程序会自动操作已登录的{label}：切到前台 → 搜索群名 → 进入群聊 → 粘贴内容 → 发送。不调用企业微信接口，群在“群管理”里按群名添加。发送时会占用屏幕和剪贴板几秒钟，电脑锁屏时无法发送；程序会进入搜索结果的第一个，开启“发送前核对群名”后进错群不会发。</p>
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
          </div>
          <label className="toggle-row"><input type="checkbox" checked={rpa.verifyChat} onChange={event => patch({ verifyChat: event.target.checked })} />发送前核对群名（用 Windows 自带 OCR 识别聊天标题，对不上就不发）</label>
          <label className="toggle-row"><input type="checkbox" checked={rpa.minimizeAfterSend} onChange={event => patch({ minimizeAfterSend: event.target.checked })} />发送成功后把{label}最小化，切回原来的窗口</label>
          <h4 className="sub-title">防封保护（内置，不可关闭）</h4>
          <p className="hint">按真人的节奏发，下面的规则一直生效，不能调高：</p>
          <ul className="guard-list">
            <li>每一步操作随机停顿，群与群之间随机间隔 {DEFAULT_RPA_GUARD.groupGapMinSec}–{DEFAULT_RPA_GUARD.groupGapMaxSec} 秒</li>
            <li>每小时最多 {DEFAULT_RPA_GUARD.maxPerHour} 次，每天最多 {DEFAULT_RPA_GUARD.maxPerDay} 次，同一个群每天最多 {DEFAULT_RPA_GUARD.maxPerGroupPerDay} 次（发到一个群算一次）</li>
            <li>开头随机加一句问候，让多个群收到的文字不完全一样；每次最多附 {DEFAULT_RPA_GUARD.maxImages} 张图</li>
            <li>连续失败 {DEFAULT_RPA_GUARD.pauseAfterFailures} 次自动暂停 {DEFAULT_RPA_GUARD.pauseMinutes} 分钟</li>
            <li>发送前后检查{label}有没有弹出“安全验证 / 设备环境异常”，一旦弹出就暂停全部发送并通知，扫码验证后点“检测本机客户端”恢复</li>
          </ul>
          <div className="form-grid">
            <Field label="发送时段" hint="时段外到点的任务顺延到下一个时段开始">
              <div className="inline-actions"><input type="time" value={guard.activeStart} onChange={event => patchGuard({ activeStart: event.target.value })} /><span>到</span><input type="time" value={guard.activeEnd} onChange={event => patchGuard({ activeEnd: event.target.value })} /></div>
            </Field>
            <Field label="每次附带攻略图（张）" hint={`取内容关联路线里素材的图片，0 表示只发文字，最多 ${DEFAULT_RPA_GUARD.maxImages} 张`}><input type="number" min={0} max={DEFAULT_RPA_GUARD.maxImages} value={guard.maxImages} onChange={num('maxImages')} /></Field>
          </div>
          <p className="hint">另外请做到：用一台专用的实体电脑长期登录，不开远程控制、录屏和抓包工具；发送时不要有人操作这台电脑；新账号前一两周少发，可以先用“只粘贴，人工按发送”。</p>
          {!isAgent && <AccountPool pool={pool} onChange={setPool} />}

      <Notice notice={notice} />
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(() => call('settings.checkRpa', { rpa }))}>检测本机客户端</button>
        <button className="primary" disabled={busy || !dirty} onClick={save}>保存</button>
      </div>
    </Card>
    <MailCard />
  </>;
}

/** 提醒邮件：客户端弹出安全验证时发邮件，每台电脑（主控、执行端）各自配置。 */
function MailCard() {
  const [saved, setSaved] = useState<MailSettingsView | null>(null);
  const [form, setForm] = useState<MailSettingsView | null>(null);
  const [password, setPassword] = useState('');
  const { busy, notice, run } = useAction();
  useEffect(() => { void call('settings.getMail').then(view => { setSaved(view); setForm(view); }); }, []);
  if (!form || !saved) return <Card title="提醒邮件"><p className="hint">正在加载…</p></Card>;
  const patch = (next: Partial<MailSettingsView>) => setForm({ ...form, ...next });
  const input = () => ({ enabled: form.enabled, host: form.host, port: form.port, secure: form.secure, user: form.user, to: form.to, password });
  return <Card title="提醒邮件">
    <p className="hint">客户端弹出安全验证（要求手机扫码）时，除了弹系统通知，还会发邮件到下面的邮箱。验证通常有 5 分钟时限，建议收件邮箱在手机上开着推送。执行端电脑要在它自己的程序里单独配置。</p>
    <label className="toggle-row"><input type="checkbox" checked={form.enabled} onChange={event => patch({ enabled: event.target.checked })} />启用提醒邮件</label>
    <div className="form-grid">
      <Field label="SMTP 服务器" hint="腾讯企业邮 smtp.exmail.qq.com，QQ 邮箱 smtp.qq.com，163 邮箱 smtp.163.com"><input value={form.host} onChange={event => patch({ host: event.target.value })} placeholder="smtp.exmail.qq.com" /></Field>
      <Field label="端口" hint="465 勾选 SSL；587 不勾选（用 STARTTLS）"><div className="inline-actions"><input type="number" value={form.port} onChange={event => patch({ port: Number(event.target.value) })} /><label className="toggle-row"><input type="checkbox" checked={form.secure} onChange={event => patch({ secure: event.target.checked })} />SSL</label></div></Field>
      <Field label="发件邮箱"><input value={form.user} onChange={event => patch({ user: event.target.value })} placeholder="name@company.com" /></Field>
      <Field label="授权码 / 密码" hint="邮箱设置里开启 SMTP 后生成的授权码，加密保存在本机"><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder={saved.hasPassword ? '已保存，留空则不修改' : '填写授权码'} autoComplete="off" /></Field>
      <Field label="收件人" hint="多个用逗号分隔，可以填企业邮箱和个人邮箱"><input value={form.to} onChange={event => patch({ to: event.target.value })} placeholder="ops@company.com" /></Field>
    </div>
    <Notice notice={notice} />
    <div className="actions">
      <button className="secondary" disabled={busy} onClick={() => void run(() => call('settings.testMail', input()))}>发测试邮件</button>
      <button className="primary" disabled={busy} onClick={() => void run(async () => { const view = await call('settings.saveMail', input()); setSaved(view); setForm(view); setPassword(''); return view.enabled ? '已保存，弹出安全验证时会发邮件提醒' : '已保存，提醒邮件未启用'; })}>保存</button>
    </div>
  </Card>;
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
