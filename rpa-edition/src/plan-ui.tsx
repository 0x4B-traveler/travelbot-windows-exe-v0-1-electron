import React, { useState } from 'react';
import { call, formatTime } from './api';
import { BATCH_STATUS_LABELS, localDateText, shortDate, type BatchPreview, type BatchStatus, type PlanMessage, type SendBatch } from './domain/ops';
import { Modal, Notice, Pill, useAction, useLoad } from './ui';

// 发送计划相关的共用组件：状态标签、一组消息的内容、预览弹窗（首页、群管理、内容中心、发送计划都用）。

export const BATCH_TONE: Record<BatchStatus, 'ok' | 'warn' | 'fail' | 'info' | 'muted'> = { planned: 'warn', sending: 'info', sent: 'ok', partial: 'fail', failed: 'fail', skipped: 'muted', missed: 'fail' };

export function BatchPill({ status }: { status: BatchStatus }) {
  return <Pill tone={BATCH_TONE[status]}>{BATCH_STATUS_LABELS[status]}</Pill>;
}

/** 一组里每条消息的完整文字；发过的标出结果。 */
export function MessageList({ messages }: { messages: PlanMessage[] }) {
  if (!messages.length) return <p className="hint">这一天没有要发的内容。</p>;
  return <div className="message-list">{messages.map((message, index) => <div className="message-card" key={index}>
    <div className="message-head">
      <strong>{index + 1}. {message.label}</strong>
      <span className="inline-actions">
        {message.imageCount > 0 && <small>附 {message.imageCount} 张图</small>}
        {message.status === 'sent' && <Pill tone="ok">已发出 {formatTime(message.sentAt, false)}</Pill>}
        {message.status === 'failed' && <Pill tone="fail">没发出去</Pill>}
      </span>
    </div>
    <p className="pre">{message.text}</p>
    {message.error && <small className="danger-text">{message.error}</small>}
  </div>)}</div>;
}

/** 预览某个群某天傍晚的一组：实时查天气、套模板；可以跳过、恢复，或发到文件传输助手试看。 */
export function PreviewModal({ groupId, date, onClose, onChanged, batch }: { groupId: string; date: string; onClose: () => void; onChanged?: () => Promise<void> | void; batch?: SendBatch }) {
  const [preview, error, reload] = useLoad<BatchPreview>(() => call('plan.preview', { groupId, date }), [groupId, date]);
  const { busy, notice, run } = useAction();
  const [self, setSelf] = useState<SendBatch | null>(null);
  const done = async (message: string) => { await reload(); await onChanged?.(); return message; };
  const isToday = date === localDateText(new Date());
  const canSkip = batch?.kind === 'evening' && batch.status === 'planned' && !batch.messages?.some(message => message.status === 'sent');
  const canUnskip = batch && batch.kind === 'evening' && batch.status === 'skipped' && batch.id;
  return <Modal title={`${preview?.groupName ?? ''} · ${shortDate(date)}傍晚${preview?.dayNo ? `（明天第 ${preview.dayNo} 天）` : ''}`} onClose={onClose} wide>
    {error && <p className="notice error">{error}</p>}
    {!preview && !error && <p className="hint">正在查明天的天气、生成内容…</p>}
    {preview && <>
      {preview.weather && <p className="hint">明天{preview.weather.city}：{preview.weather.condition}，{Math.round(preview.weather.min)}–{Math.round(preview.weather.max)}℃</p>}
      {preview.notes.map(note => <p key={note} className="notice error">{note}</p>)}
      <MessageList messages={self?.messages ?? preview.messages} />
    </>}
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <span className="hint">{self ? '上面是发到文件传输助手的结果' : '这是预览，没有发出任何消息'}</span>
      <span className="inline-actions">
        {canSkip && <button className="secondary" disabled={busy} onClick={() => void run(async () => { await call('plan.skip', { groupId, date }); return done('已跳过，这一组不会发'); })}>跳过这一组</button>}
        {canUnskip && <button className="secondary" disabled={busy} onClick={() => void run(async () => { await call('plan.unskip', { groupId, date }); return done('已恢复，会按时发送'); })}>恢复发送</button>}
        {preview && preview.messages.length > 0 && <button className="secondary" disabled={busy} title="内容和正式发的一样，只发到自己的文件传输助手" onClick={() => void run(async () => {
          if (!window.confirm('把这一组发到自己的“文件传输助手”试看？会操作企业微信，也计入每小时、每天的发送次数。')) return;
          const result = await call('plan.sendToSelf', { groupId, date }); setSelf(result);
          if (result.status !== 'sent') throw new Error(`没发完：${result.lastResult ?? '详见运行日志'}`);
          return '已发到文件传输助手，请在企业微信里查看';
        })}>发到文件传输助手试看</button>}
        {isToday && batch?.kind === 'evening' && batch.status === 'planned' && <button className="primary" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm(`现在就把这一组发到“${preview?.groupName}”？`)) return;
          const result = await call('plan.sendNow', { groupId, date });
          await done('');
          if (result.status !== 'sent') throw new Error(result.lastResult ?? '没发完，详见运行日志');
          return `已发出 ${result.labels.length} 条`;
        })}>现在就发</button>}
      </span>
    </div>
  </Modal>;
}
