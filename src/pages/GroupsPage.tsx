import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { GROUP_CHANNEL_LABELS, RPA_CLIENT_LABELS, groupCapabilities, isManualGroup, resolveAccount, type OpsGroup, type SendSettings } from '../domain/ops';
import { Card, Empty, Modal, Notice, Pill, useAction, useLoad } from '../ui';

/** 群管理：只负责“发给谁”——群信息、启用停用、匹配规则和发送测试。 */
export function GroupsPage() {
  const [groups, error, reload] = useLoad(() => call('group.list'), []);
  const [send] = useLoad(() => call('settings.getSend'), []);
  const [open, setOpen] = useState<OpsGroup | null>(null);
  const [adding, setAdding] = useState(false);
  const rpaMode = send?.mode === 'rpa';
  const multiAccount = rpaMode && (send?.pool.accounts.length ?? 0) > 1;
  const accountName = (group: OpsGroup) => {
    if (!send || group.channel !== 'customer') return '—';
    const account = resolveAccount(send.pool, group.accountId);
    return account ? `${account.name}${group.accountId ? '' : '（默认）'}` : '无可用账号';
  };
  const { busy, notice, run } = useAction();
  const refresh = () => void run(async () => {
    const result = await call('group.refresh');
    await reload();
    if (result.warnings.length && !result.added && !result.updated) throw new Error(result.warnings.join('。'));
    return [`刷新完成：新增 ${result.added} 个，更新 ${result.updated} 个${result.missing ? `，${result.missing} 个群找不到了` : ''}`, ...result.warnings].join('。');
  });

  return <>
    <Card title={`群（${groups?.length ?? 0}）`} extra={<span className="inline-actions"><button className="secondary" disabled={busy} onClick={() => setAdding(true)}>手动添加群</button><button className="primary" disabled={busy} onClick={refresh}>{busy ? '刷新中…' : '刷新群列表'}</button></span>}>
      <p className="hint">{rpaMode
        ? `当前发送方式：桌面客户端（RPA）。客户群会在${RPA_CLIENT_LABELS[send!.rpa.client]}里按群名搜索后直接发出${multiAccount ? '，由“发送账号”那台电脑上的账号发，点开群可以换账号' : ''}；没有接口时可用“手动添加群”按群名添加。机器人群仍由机器人直接发送。`
        : '当前发送方式：企业微信接口。机器人群：智能机器人所在的群聊，消息直接发出。客户群：通过“客户群群发”创建任务，群主在企业微信里确认后才发出。可在“设置”里切换为 RPA。'}</p>
      <Notice notice={notice} />
      {error && <p className="notice error">{error}</p>}
      {groups?.length ? <table className="ops-table clickable">
        <thead><tr><th>群名称</th><th>类型</th>{multiAccount && <th>发送账号</th>}<th>群主 / 人数</th><th>最后发送</th><th>今日发送</th><th>状态</th></tr></thead>
        <tbody>{groups.map(group => <tr key={group.id} onClick={() => setOpen(group)}>
          <td><strong>{group.name}</strong></td><td>{GROUP_CHANNEL_LABELS[group.channel]}{isManualGroup(group) && '（手动）'}</td>{multiAccount && <td>{accountName(group)}</td>}
          <td>{group.channel === 'customer' && !isManualGroup(group) ? `${group.owner || '—'} / ${group.memberCount} 人` : '—'}</td>
          <td className="mono">{formatTime(group.lastSentAt) || '—'}</td><td>{group.todaySent}</td>
          <td>{!group.available ? <Pill tone="fail">找不到</Pill> : group.enabled ? <Pill tone="ok">启用</Pill> : <Pill tone="muted">停用</Pill>}</td>
        </tr>)}</tbody>
      </table> : groups && <Empty action={<button className="secondary" onClick={refresh}>刷新群列表</button>}>还没有群。先在“设置”里完成企业微信扫码授权再刷新群列表；用 RPA 发送时也可以“手动添加群”。</Empty>}
    </Card>
    {open && <GroupDetail group={open} send={send} onClose={() => setOpen(null)} onChanged={async next => { setOpen(next); await reload(); }} onDeleted={async () => { setOpen(null); await reload(); }} />}
    {adding && <AddGroups onClose={() => setAdding(false)} onAdded={reload} rpaMode={rpaMode} send={send} />}
  </>;
}

function AddGroups({ onClose, onAdded, rpaMode, send }: { onClose: () => void; onAdded: () => Promise<void>; rpaMode: boolean; send: SendSettings | null }) {
  const [text, setText] = useState('');
  const [accountId, setAccountId] = useState('');
  const { busy, notice, run } = useAction();
  const names = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  return <Modal title="手动添加客户群" onClose={onClose}>
    <p className="hint">每行一个群名，和{rpaMode ? '客户端' : '企业微信'}里显示的群名完全一致。手动添加的群用 RPA 发送{rpaMode ? '' : '（当前是接口模式，需要先到“设置”切换为 RPA 才能发送）'}；以后接口能拉到同名群时会自动接上。</p>
    {send && send.pool.accounts.length > 1 && <label className="field"><span>发送账号</span><AccountSelect send={send} value={accountId} onChange={setAccountId} /></label>}
    <label className="field"><span>群名称</span><textarea value={text} onChange={event => setText(event.target.value)} placeholder={'云南6日游 10月8日团\n厦门亲子游 VIP 群'} /></label>
    <Notice notice={notice} />
    <div className="inline-actions spread"><span className="hint">{names.length ? `将添加 ${names.length} 个群` : ''}</span>
      <button className="primary" disabled={busy || !names.length} onClick={() => void run(async () => {
        const added = await call('group.add', { names, accountId: accountId || undefined });
        await onAdded(); setText('');
        return `已添加 ${added.length} 个群${names.length > added.length ? `，${names.length - added.length} 个同名群已存在` : ''}`;
      })}>添加</button>
    </div>
  </Modal>;
}

function GroupDetail({ group, send, onClose, onChanged, onDeleted }: { group: OpsGroup; send: SendSettings | null; onClose: () => void; onChanged: (next: OpsGroup) => Promise<void>; onDeleted: () => Promise<void> }) {
  const [text, setText] = useState('【旅游运营助手】群发送测试，请忽略 ✅');
  const { busy, notice, run } = useAction();
  const mode = send?.mode ?? 'api';
  const capabilities = groupCapabilities(group.channel, mode);
  const via = group.channel === 'bot' ? '机器人' : mode === 'rpa' ? `RPA（${RPA_CLIENT_LABELS[send!.rpa.client]}客户端）` : '企业微信接口';
  return <Modal title={group.name} onClose={onClose}>
    <dl className="detail-grid">
      <dt>类型</dt><dd>{GROUP_CHANNEL_LABELS[group.channel]}</dd>
      <dt>匹配方式</dt><dd>
        <select value={group.matchMode} onChange={event => void run(async () => { await onChanged(await call('group.update', { id: group.id, matchMode: event.target.value as OpsGroup['matchMode'] })); return '匹配方式已更新'; })}>
          <option value="id">群 ID（群重建后需要重新选择）</option><option value="name">群名称（群重建后按同名自动接上）</option>
        </select>
      </dd>
      <dt>发送途径</dt><dd>{via}</dd>
      {group.channel === 'customer' && send && send.pool.accounts.length > 1 && <><dt>发送账号</dt><dd>
        <AccountSelect send={send} value={group.accountId ?? ''} onChange={value => void run(async () => { await onChanged(await call('group.update', { id: group.id, accountId: value })); return '发送账号已更新，请确认这个账号在群里'; })} />
      </dd></>}
      <dt>发送能力</dt><dd>{capabilities.text ? '✓ 文本' : '✕ 文本'}　{capabilities.image ? '✓ 图片' : '✕ 图片（暂不支持）'}{capabilities.needsConfirm ? '　· 需群主确认' : ''}</dd>
      {group.channel === 'customer' && !isManualGroup(group) && <><dt>群主</dt><dd>{group.owner || '—'}（{group.memberCount} 人）</dd></>}
      <dt>最后发送</dt><dd>{formatTime(group.lastSentAt) || '—'}</dd>
      <dt>今日发送</dt><dd>{group.todaySent}</dd>
      <dt>状态</dt><dd>{!group.available ? '最近一次刷新时找不到这个群' : group.enabled ? '启用' : '停用（运营任务不会发到这个群）'}</dd>
    </dl>
    <label className="field"><span>测试发送</span><textarea value={text} onChange={event => setText(event.target.value)} /></label>
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <span className="inline-actions">
        <button className="secondary" disabled={busy} onClick={() => void run(async () => { await onChanged(await call('group.update', { id: group.id, enabled: !group.enabled })); return group.enabled ? '已停用' : '已启用'; })}>{group.enabled ? '停用这个群' : '启用这个群'}</button>
        {isManualGroup(group) && <button className="secondary" disabled={busy} onClick={() => void run(async () => { if (!window.confirm(`删除“${group.name}”？`)) return; await call('group.delete', { id: group.id }); await onDeleted(); })}>删除</button>}
      </span>
      <button className="primary" disabled={busy || !group.enabled || !group.available || !text.trim()} onClick={() => void run(() => call('group.testSend', { id: group.id, text }))}>测试发送</button>
    </div>
  </Modal>;
}

function AccountSelect({ send, value, onChange }: { send: SendSettings; value: string; onChange: (value: string) => void }) {
  const fallback = resolveAccount(send.pool, undefined);
  return <select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">默认（{fallback?.name ?? '无可用账号'}）</option>
    {send.pool.accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.enabled ? '' : '（已停用）'}{account.kind === 'remote' ? ` · ${account.host}` : ' · 本机'}</option>)}
  </select>;
}
