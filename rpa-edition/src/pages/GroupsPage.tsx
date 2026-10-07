import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { RPA_CLIENT_LABELS, resolveAccount, type OpsGroup, type SendSettings } from '../domain/ops';
import { Card, Empty, Modal, Notice, Pill, useAction, useLoad } from '../ui';

/** 群管理：只负责“发给谁”——按群名添加群、绑定发送账号、启用停用和发送测试。 */
export function GroupsPage() {
  const [groups, error, reload] = useLoad(() => call('group.list'), []);
  const [send] = useLoad(() => call('settings.getSend'), []);
  const [open, setOpen] = useState<OpsGroup | null>(null);
  const [adding, setAdding] = useState(false);
  const multiAccount = (send?.pool.accounts.length ?? 0) > 1;
  const accountName = (group: OpsGroup) => {
    if (!send) return '—';
    const account = resolveAccount(send.pool, group.accountId);
    return account ? `${account.name}${group.accountId ? '' : '（默认）'}` : '无可用账号';
  };
  const client = send ? RPA_CLIENT_LABELS[send.rpa.client] : '客户端';

  return <>
    <Card title={`群（${groups?.length ?? 0}）`} extra={<button className="primary" onClick={() => setAdding(true)}>添加群</button>}>
      <p className="hint">按群名添加，发送时在{client}里搜索群名后直接发出{multiAccount ? '，由“发送账号”那台电脑上的账号发，点开群可以换账号' : ''}。群名要和{client}里显示的一致，发送前会核对聊天标题。</p>
      {error && <p className="notice error">{error}</p>}
      {groups?.length ? <table className="ops-table clickable">
        <thead><tr><th>群名称</th>{multiAccount && <th>发送账号</th>}<th>最后发送</th><th>今日发送</th><th>状态</th></tr></thead>
        <tbody>{groups.map(group => <tr key={group.id} onClick={() => setOpen(group)}>
          <td><strong>{group.name}</strong></td>{multiAccount && <td>{accountName(group)}</td>}
          <td className="mono">{formatTime(group.lastSentAt) || '—'}</td><td>{group.todaySent}</td>
          <td>{group.enabled ? <Pill tone="ok">启用</Pill> : <Pill tone="muted">停用</Pill>}</td>
        </tr>)}</tbody>
      </table> : groups && <Empty action={<button className="secondary" onClick={() => setAdding(true)}>添加群</button>}>还没有群。按群名添加后，运营任务、行程提醒和每日推送都能选到。</Empty>}
    </Card>
    {open && <GroupDetail group={open} send={send} onClose={() => setOpen(null)} onChanged={async next => { setOpen(next); await reload(); }} onDeleted={async () => { setOpen(null); await reload(); }} />}
    {adding && <AddGroups onClose={() => setAdding(false)} onAdded={reload} send={send} />}
  </>;
}

function AddGroups({ onClose, onAdded, send }: { onClose: () => void; onAdded: () => Promise<void>; send: SendSettings | null }) {
  const [text, setText] = useState('');
  const [accountId, setAccountId] = useState('');
  const { busy, notice, run } = useAction();
  const names = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  return <Modal title="添加群" onClose={onClose}>
    <p className="hint">每行一个群名，和客户端里显示的群名完全一致，可以从 Excel 整列复制粘贴。同名的群会跳过。</p>
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
  return <Modal title={group.name} onClose={onClose}>
    <dl className="detail-grid">
      <dt>发送途径</dt><dd>RPA（{send ? RPA_CLIENT_LABELS[send.rpa.client] : ''}客户端），文字和图片都能发，不需要群主确认</dd>
      {send && send.pool.accounts.length > 1 && <><dt>发送账号</dt><dd>
        <AccountSelect send={send} value={group.accountId ?? ''} onChange={value => void run(async () => { await onChanged(await call('group.update', { id: group.id, accountId: value })); return '发送账号已更新，请确认这个账号在群里'; })} />
      </dd></>}
      <dt>最后发送</dt><dd>{formatTime(group.lastSentAt) || '—'}</dd>
      <dt>今日发送</dt><dd>{group.todaySent}</dd>
      <dt>状态</dt><dd>{group.enabled ? '启用' : '停用（不会发到这个群）'}</dd>
    </dl>
    <label className="field"><span>测试发送</span><textarea value={text} onChange={event => setText(event.target.value)} /></label>
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <span className="inline-actions">
        <button className="secondary" disabled={busy} onClick={() => void run(async () => { await onChanged(await call('group.update', { id: group.id, enabled: !group.enabled })); return group.enabled ? '已停用' : '已启用'; })}>{group.enabled ? '停用这个群' : '启用这个群'}</button>
        <button className="secondary" disabled={busy} onClick={() => void run(async () => { if (!window.confirm(`删除“${group.name}”？`)) return; await call('group.delete', { id: group.id }); await onDeleted(); })}>删除</button>
      </span>
      <button className="primary" disabled={busy || !group.enabled || !text.trim()} onClick={() => void run(() => call('group.testSend', { id: group.id, text }))}>测试发送</button>
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
