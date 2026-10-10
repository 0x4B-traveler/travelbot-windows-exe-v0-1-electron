import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { shortDate, type SendBatch } from '../domain/ops';
import { BatchPill, PreviewModal } from '../plan-ui';
import { Card, Empty, Notice, useAction, useLoad } from '../ui';
import type { PageKey } from '../App';

/** 首页：今天进行中的团、今晚每个群要发的内容（可以预览、跳过），以及最近的失败。 */
export function DashboardPage({ go }: { go: (page: PageKey) => void }) {
  const [data, error, reload] = useLoad(() => call('dashboard.get'), []);
  const [open, setOpen] = useState<SendBatch | null>(null);
  const { busy, notice, run } = useAction();
  if (!data) return <Card>{error ? <p className="notice error">{error}</p> : <p className="hint">加载中…</p>}</Card>;
  const evening = data.tonight.filter(batch => batch.kind === 'evening');
  const toSend = evening.filter(batch => batch.status === 'planned' || batch.status === 'sending').length;
  const stats: Array<{ label: string; value: number; tone: string; page: PageKey }> = [
    { label: '进行中的团', value: data.ongoing, tone: 'ok', page: 'groups' },
    { label: '待出发的团', value: data.upcoming, tone: 'info', page: 'groups' },
    { label: '今晚待发', value: toSend, tone: 'warn', page: 'plan' },
    { label: '24 小时内失败', value: data.recentFailures.length, tone: 'fail', page: 'logs' },
  ];
  return <>
    <div className="stat-grid">{stats.map(stat => <button key={stat.label} className={`stat-card tone-${stat.tone}`} onClick={() => go(stat.page)}><small>{stat.label}</small><b>{stat.value}</b></button>)}</div>
    <div className="dash-grid">
      <Card title={`今晚要发（${data.eveningStart} 开始）`} extra={<button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button>}>
        <p className="hint">点开一个群可以看到完整内容（实时查明天的天气），内容不对可以跳过这个群。</p>
        <Notice notice={notice} />
        {data.tonight.length ? <table className="ops-table clickable">
          <thead><tr><th>群</th><th>内容</th><th>状态</th><th className="right"></th></tr></thead>
          <tbody>{data.tonight.map((batch, index) => <tr key={batch.id ?? `${batch.groupId}-${index}`} onClick={() => batch.kind === 'evening' && setOpen(batch)}>
            <td><strong>{batch.groupName}</strong><small>{batch.kind === 'oneoff' ? '临时消息' : batch.dayNo === 1 ? '明天出发' : `明天第 ${batch.dayNo} 天`}</small></td>
            <td>{batch.labels.join('、')}</td>
            <td><BatchPill status={batch.status} />{batch.lastResult && <small className={batch.status === 'failed' || batch.status === 'partial' ? 'danger-text' : ''}>{batch.lastResult}</small>}{batch.status === 'sent' && batch.updatedAt && <small>{formatTime(batch.updatedAt, false)}</small>}</td>
            <td className="right actions-cell" onClick={event => event.stopPropagation()}>
              {batch.kind === 'evening' && batch.status === 'planned' && <button className="link" disabled={busy} onClick={() => void run(async () => { await call('plan.skip', { groupId: batch.groupId, date: batch.date }); await reload(); return `已跳过“${batch.groupName}”今晚这一组`; })}>跳过</button>}
              {batch.kind === 'evening' && batch.status === 'skipped' && batch.id && <button className="link" disabled={busy} onClick={() => void run(async () => { await call('plan.unskip', { groupId: batch.groupId, date: batch.date }); await reload(); return `已恢复“${batch.groupName}”今晚这一组`; })}>恢复</button>}
              {batch.id && (batch.status === 'failed' || batch.status === 'partial') && <button className="link" disabled={busy} onClick={() => void run(async () => { const result = await call('plan.retry', { id: batch.id! }); await reload(); if (result.status !== 'sent') throw new Error(result.lastResult ?? '还是没发完'); return '没发出去的已补发'; })}>重发</button>}
            </td>
          </tr>)}</tbody>
        </table> : <Empty action={<button className="secondary" onClick={() => go('groups')}>去群管理新增团</button>}>今晚没有要发的群。</Empty>}
      </Card>
      <div>
        <Card title="进行中的团" extra={<button className="link" onClick={() => go('groups')}>全部群</button>}>
          {data.ongoingGroups.length ? <div className="mini-list">{data.ongoingGroups.map(group => <button key={group.id} className="mini-item" onClick={() => go('groups')}>
            <strong>{group.name}</strong><small>{group.routeName} · 第 {group.dayNo}/{group.tourDays} 天 · {shortDate(group.endDate ?? '')}结束</small>
          </button>)}</div> : <Empty>今天没有进行中的团。</Empty>}
        </Card>
        {data.recentFailures.length > 0 && <Card title="最近失败" extra={<button className="link" onClick={() => go('logs')}>运行日志</button>}>
          <div className="mini-list">{data.recentFailures.map(entry => <div key={entry.id} className="mini-item static"><strong className="danger-text">{entry.groupName ?? entry.action}</strong><small>{formatTime(entry.time)} · {entry.message}</small></div>)}</div>
        </Card>}
      </div>
    </div>
    {open && <PreviewModal groupId={open.groupId} date={open.date} batch={open} onClose={() => setOpen(null)} onChanged={async () => { setOpen(null); await reload(); }} />}
  </>;
}
