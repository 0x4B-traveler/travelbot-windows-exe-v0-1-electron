import React, { useEffect, useState } from 'react';
import { call } from '../api';
import { DEFAULT_AGENT_PORT, POOL_ROLE_LABELS, RPA_CLIENT_LABELS, type AccountStatus, type MailSettingsView, type PoolRole, type PoolSettings, type RpaAccount, type RpaClient, type RpaSettings, type SendSettings, type TourScheduleSettings } from '../domain/ops';
import { Card, Field, Notice, useAction } from '../ui';

/** 设置：团的发送时间、RPA 发送（桌面客户端、发送时段、账号池）、提醒邮件和备份，保存后立即生效；防封规则内置，界面上不显示。 */
export function SettingsPage() {
  const [saved, setSaved] = useState<SendSettings | null>(null);
  const [rpa, setRpa] = useState<RpaSettings | null>(null);
  const [pool, setPool] = useState<PoolSettings | null>(null);
  const [tour, setTour] = useState<TourScheduleSettings | null>(null);
  const [agent, setAgent] = useState<Awaited<ReturnType<typeof loadAgent>> | null>(null);
  const { busy, notice, run } = useAction();
  const apply = (value: SendSettings) => { setSaved(value); setRpa(value.rpa); setPool(value.pool); setTour(value.tour); };
  useEffect(() => { void call('settings.getSend').then(apply); void loadAgent().then(setAgent); }, []);
  if (!saved || !rpa || !pool || !tour) return <Card title="RPA 发送"><p className="hint">正在加载…</p></Card>;
  const patch = (next: Partial<RpaSettings>) => setRpa({ ...rpa, ...next });
  const guard = rpa.guard;
  const dirty = JSON.stringify(rpa) !== JSON.stringify(saved.rpa) || JSON.stringify(pool) !== JSON.stringify(saved.pool) || JSON.stringify(tour) !== JSON.stringify(saved.tour);
  const save = () => void run(async () => {
    const next = await call('settings.saveSend', { rpa, pool, tour });
    apply(next);
    // 执行端的局域网服务是异步启动的，稍等再读状态
    window.setTimeout(() => void loadAgent().then(setAgent), 800);
    return next.pool.role === 'agent' ? '已保存：本机作为执行端，等待主控发来的发送指令' : `已保存：按账号池发送（${next.pool.accounts.filter(account => account.enabled).length} 个可用账号）`;
  });
  const isAgent = pool.role === 'agent';
  const label = RPA_CLIENT_LABELS[rpa.client];
  const lateStart = tour.eveningStart < guard.activeStart || tour.eveningStart >= guard.activeEnd;
  return <>
    {!isAgent && <Card title="团的发送时间">
      <p className="hint">每天到了这个时间，自动给每个进行中的团发当晚的消息（明日提醒、酒店TIPS、景点攻略），一个群一个群地发完。群比较多时可以把时间提前一些。</p>
      <div className="form-grid">
        <Field label="每天傍晚开始发送"><input type="time" value={tour.eveningStart} onChange={event => setTour({ ...tour, eveningStart: event.target.value })} /></Field>
        <Field label="开机自动启动" group hint="电脑重启后自动在后台运行（安装版 Windows 有效）"><label className="toggle-row"><input type="checkbox" checked={tour.launchAtLogin} onChange={event => setTour({ ...tour, launchAtLogin: event.target.checked })} />开机后自动启动并最小化到托盘</label></Field>
      </div>
      {lateStart && <p className="notice error">请选 {guard.activeStart}–{guard.activeEnd} 之间的时间，太早或太晚不会发送。</p>}
      <div className="actions"><button className="primary" disabled={busy || !dirty} onClick={save}>保存</button></div>
    </Card>}
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
            <p className="hint">{saved.pool.role !== 'agent' ? '保存后开始监听。' : agent?.listening ? `正在监听端口 ${agent.port}，等待主控的指令。第一次启动时 Windows 防火墙可能会询问，请选择“允许”。` : `没有在监听：${agent?.error || '请保存后重试'}`}本机的客户端设置只对本机账号生效。</p>
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
          {!isAgent && <AccountPool pool={pool} onChange={setPool} />}

      <Notice notice={notice} />
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(() => call('settings.checkRpa', { rpa }))}>检测本机客户端</button>
        <button className="primary" disabled={busy || !dirty} onClick={save}>保存</button>
      </div>
    </Card>
    <MailCard />
    {!isAgent && <BackupCard />}
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

/** 备份：数据都在这台电脑的 SQLite 里，定期导出一份存到别处（U 盘、网盘）。 */
function BackupCard() {
  const { busy, notice, run } = useAction();
  return <Card title="数据备份">
    <p className="hint">路线、酒店和景点（含攻略图）、群和团、模板、天气对照表和发送记录都存在这台电脑上。建议每周导出一份备份，存到 U 盘或网盘；换电脑时在新电脑上“从备份恢复”。设置和邮箱授权码不在备份里。</p>
    <Notice notice={notice} />
    <div className="actions">
      <button className="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await call('backup.restore');
        return result ? '正在恢复，程序马上重启' : '';
      })}>从备份恢复</button>
      <button className="primary" disabled={busy} onClick={() => void run(async () => {
        const result = await call('backup.export');
        return result ? `已导出到 ${result.path}：路线 ${result.routes} 条、群 ${result.groups} 个、素材 ${result.materials} 条、图片 ${result.images} 张` : '';
      })}>导出备份</button>
    </div>
  </Card>;
}

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
    <p className="hint">每个账号对应一台登录了企业微信的电脑。其他电脑装好本程序、在“本机角色”选执行端，再把它显示的 IP、端口和口令填到这里。</p>
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
