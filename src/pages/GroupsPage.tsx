import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { GROUP_CAPABILITIES, GROUP_CHANNEL_LABELS, type OpsGroup } from '../domain/ops';
import { Card, Empty, Modal, Notice, Pill, useAction, useLoad } from '../ui';

/** 群管理：只负责“发给谁”——群信息、启用停用、匹配规则和发送测试。 */
export function GroupsPage() {
  const [groups, error, reload] = useLoad(() => call('group.list'), []);
  const [open, setOpen] = useState<OpsGroup | null>(null);
  const { busy, notice, run } = useAction();
  const refresh = () => void run(async () => {
    const result = await call('group.refresh');
    await reload();
    if (result.warnings.length && !result.added && !result.updated) throw new Error(result.warnings.join('。'));
    return [`刷新完成：新增 ${result.added} 个，更新 ${result.updated} 个${result.missing ? `，${result.missing} 个群找不到了` : ''}`, ...result.warnings].join('。');
  });

  return <>
    <Card title={`群（${groups?.length ?? 0}）`} extra={<button className="primary" disabled={busy} onClick={refresh}>{busy ? '刷新中…' : '刷新群列表'}</button>}>
      <p className="hint">机器人群：智能机器人所在的群聊，消息直接发出。客户群：通过“客户群群发”创建任务，群主在企业微信里确认后才发出。</p>
      <Notice notice={notice} />
      {error && <p className="notice error">{error}</p>}
      {groups?.length ? <table className="ops-table clickable">
        <thead><tr><th>群名称</th><th>类型</th><th>群主 / 人数</th><th>最后发送</th><th>今日发送</th><th>状态</th></tr></thead>
        <tbody>{groups.map(group => <tr key={group.id} onClick={() => setOpen(group)}>
          <td><strong>{group.name}</strong></td><td>{GROUP_CHANNEL_LABELS[group.channel]}</td>
          <td>{group.channel === 'customer' ? `${group.owner || '—'} / ${group.memberCount} 人` : '—'}</td>
          <td className="mono">{formatTime(group.lastSentAt) || '—'}</td><td>{group.todaySent}</td>
          <td>{!group.available ? <Pill tone="fail">找不到</Pill> : group.enabled ? <Pill tone="ok">启用</Pill> : <Pill tone="muted">停用</Pill>}</td>
        </tr>)}</tbody>
      </table> : groups && <Empty action={<button className="secondary" onClick={refresh}>刷新群列表</button>}>还没有群。先在“设置”里完成企业微信扫码授权，再刷新群列表。</Empty>}
    </Card>
    {open && <GroupDetail group={open} onClose={() => setOpen(null)} onChanged={async next => { setOpen(next); await reload(); }} />}
  </>;
}

function GroupDetail({ group, onClose, onChanged }: { group: OpsGroup; onClose: () => void; onChanged: (next: OpsGroup) => Promise<void> }) {
  const [text, setText] = useState('【旅游运营助手】群发送测试，请忽略 ✅');
  const { busy, notice, run } = useAction();
  const capabilities = GROUP_CAPABILITIES[group.channel];
  return <Modal title={group.name} onClose={onClose}>
    <dl className="detail-grid">
      <dt>类型</dt><dd>{GROUP_CHANNEL_LABELS[group.channel]}</dd>
      <dt>匹配方式</dt><dd>
        <select value={group.matchMode} onChange={event => void run(async () => { await onChanged(await call('group.update', { id: group.id, matchMode: event.target.value as OpsGroup['matchMode'] })); return '匹配方式已更新'; })}>
          <option value="id">群 ID（群重建后需要重新选择）</option><option value="name">群名称（群重建后按同名自动接上）</option>
        </select>
      </dd>
      <dt>发送能力</dt><dd>{capabilities.text ? '✓ 文本' : '✕ 文本'}　{capabilities.image ? '✓ 图片' : '✕ 图片（暂不支持）'}{capabilities.needsConfirm ? '　· 需群主确认' : ''}</dd>
      {group.channel === 'customer' && <><dt>群主</dt><dd>{group.owner || '—'}（{group.memberCount} 人）</dd></>}
      <dt>最后发送</dt><dd>{formatTime(group.lastSentAt) || '—'}</dd>
      <dt>今日发送</dt><dd>{group.todaySent}</dd>
      <dt>状态</dt><dd>{!group.available ? '最近一次刷新时找不到这个群' : group.enabled ? '启用' : '停用（运营任务不会发到这个群）'}</dd>
    </dl>
    <label className="field"><span>测试发送</span><textarea value={text} onChange={event => setText(event.target.value)} /></label>
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <button className="secondary" disabled={busy} onClick={() => void run(async () => { await onChanged(await call('group.update', { id: group.id, enabled: !group.enabled })); return group.enabled ? '已停用' : '已启用'; })}>{group.enabled ? '停用这个群' : '启用这个群'}</button>
      <button className="primary" disabled={busy || !group.enabled || !group.available || !text.trim()} onClick={() => void run(() => call('group.testSend', { id: group.id, text }))}>测试发送</button>
    </div>
  </Modal>;
}
