import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { addDays, BATCH_STATUS_LABELS, localDateText, shortDate, type BatchStatus, type SendBatch } from '../domain/ops';
import { BatchPill, MessageList, PreviewModal } from '../plan-ui';
import { Card, Empty, Modal, Notice, Tabs, useAction, useLoad } from '../ui';

type Filter = 'upcoming' | 'past' | 'problem';

/** 发送计划：按团自动排出的每一组消息，只看和跳过、重发，不手动建任务。 */
export function PlanPage() {
  const today = localDateText(new Date());
  const [filter, setFilter] = useState<Filter>('upcoming');
  const range = filter === 'upcoming' ? { from: today, to: addDays(today, 14) } : { from: addDays(today, -30), to: today };
  const [batches, error, reload] = useLoad(() => call('plan.list', range), [filter]);
  const [preview, setPreview] = useState<SendBatch | null>(null);
  const [record, setRecord] = useState<SendBatch | null>(null);
  const { busy, notice, run } = useAction();
  const problem = (status: BatchStatus) => status === 'failed' || status === 'partial' || status === 'missed';
  const list = (batches ?? []).filter(batch => filter === 'upcoming' ? batch.date >= today && !(batch.date === today && batch.status === 'sent') : filter === 'past' ? batch.date <= today && batch.id : problem(batch.status));
  const shown = filter === 'past' ? [...list].reverse() : list;
  const open = (batch: SendBatch) => (batch.id && batch.messages?.length ? setRecord(batch) : batch.kind === 'evening' && setPreview(batch));

  return <>
    <Card title="发送计划" extra={<button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button>}>
      <p className="hint">每个进行中的团每天傍晚发一组：出发前一天加发行程总览和酒店明细，之后每晚是明日提醒、今晚的酒店TIPS和明天的景点攻略。一组算一次发送；一组里某条失败，重发时只补没发出去的。</p>
      <Tabs<Filter> value={filter} onChange={setFilter} options={[{ value: 'upcoming', label: '接下来 14 天' }, { value: 'past', label: '已发送记录' }, { value: 'problem', label: '失败和错过' }]} />
      <Notice notice={notice} />
      {error && <p className="notice error">{error}</p>}
      {shown.length ? <table className="ops-table clickable">
        <thead><tr><th>日期</th><th>群</th><th>内容</th><th>状态</th><th className="right">操作</th></tr></thead>
        <tbody>{shown.map((batch, index) => <tr key={batch.id ?? `${batch.groupId}-${batch.date}-${index}`} onClick={() => open(batch)}>
          <td className="mono">{shortDate(batch.date)}<small>{batch.kind === 'oneoff' ? formatTime(batch.updatedAt, false) : batch.status === 'planned' && batch.notBefore ? `${formatTime(batch.notBefore, false)} 起` : ''}</small></td>
          <td><strong>{batch.groupName}</strong><small>{batch.kind === 'oneoff' ? '临时消息' : batch.dayNo === 1 ? '出发前一天' : `明天第 ${batch.dayNo} 天`}</small></td>
          <td>{batch.labels.join('、')}</td>
          <td><BatchPill status={batch.status} />{batch.lastResult && <small className={problem(batch.status) ? 'danger-text' : ''}>{batch.lastResult}</small>}</td>
          <td className="right actions-cell" onClick={event => event.stopPropagation()}>
            {batch.kind === 'evening' && batch.status === 'planned' && !batch.messages?.some(message => message.status === 'sent') && <button className="link" disabled={busy} onClick={() => void run(async () => { await call('plan.skip', { groupId: batch.groupId, date: batch.date }); await reload(); return `已跳过“${batch.groupName}”${shortDate(batch.date)}的一组`; })}>跳过</button>}
            {batch.kind === 'evening' && batch.status === 'skipped' && batch.id && batch.date >= today && <button className="link" disabled={busy} onClick={() => void run(async () => { await call('plan.unskip', { groupId: batch.groupId, date: batch.date }); await reload(); return '已恢复'; })}>恢复</button>}
            {batch.id && batch.date === today && (batch.status === 'failed' || batch.status === 'partial') && <button className="link" disabled={busy} onClick={() => void run(async () => { const result = await call('plan.retry', { id: batch.id! }); await reload(); if (result.status !== 'sent') throw new Error(result.lastResult ?? '还是没发完'); return '没发出去的已补发'; })}>重发</button>}
            {batch.kind === 'evening' && <button className="link" onClick={() => setPreview(batch)}>预览</button>}
          </td>
        </tr>)}</tbody>
      </table> : batches && <Empty>{filter === 'upcoming' ? '接下来 14 天没有要发的。到“群管理”新增团后会自动排上。' : filter === 'past' ? '最近 30 天没有发送记录。' : '最近 30 天没有失败或错过的。'}</Empty>}
    </Card>
    {preview && <PreviewModal groupId={preview.groupId} date={preview.date} batch={preview} onClose={() => setPreview(null)} onChanged={async () => { setPreview(null); await reload(); }} />}
    {record && <Modal title={`${record.groupName} · ${shortDate(record.date)}${record.kind === 'oneoff' ? ' 临时消息' : ' 傍晚的一组'}`} onClose={() => setRecord(null)} wide>
      <p className="hint">{BATCH_STATUS_LABELS[record.status]}{record.attempts ? ` · 发了 ${record.attempts} 次` : ''}{record.lastResult ? ` · ${record.lastResult}` : ''}</p>
      <MessageList messages={record.messages ?? []} />
    </Modal>}
  </>;
}
