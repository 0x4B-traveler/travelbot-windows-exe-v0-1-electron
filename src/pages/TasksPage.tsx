import React, { useState } from 'react';
import { call, formatTime, toLocalInput } from '../api';
import { GROUP_CHANNEL_LABELS, TASK_REPEAT_LABELS, TASK_STATUS_LABELS, type OpsTask, type TaskRepeat, type TaskStatus } from '../domain/ops';
import { ItineraryPanel } from '../ItineraryPanel';
import { DailyPushPanel } from '../DailyPushPanel';
import { Card, Empty, Field, Modal, Notice, Pill, Tabs, useAction, useLoad } from '../ui';

const TONE: Record<TaskStatus, 'warn' | 'info' | 'ok' | 'fail' | 'muted'> = { pending: 'warn', running: 'info', success: 'ok', failed: 'fail', cancelled: 'muted' };
type Source = 'tasks' | 'itinerary' | 'daily';
type Filter = TaskStatus | 'all';

/** 运营任务：只负责“什么时候、把什么内容、发给谁”。行程提醒、每日推送是另外两种自动任务来源。 */
export function TasksPage({ presetContentId, onPresetUsed }: { presetContentId?: string; onPresetUsed: () => void }) {
  const [source, setSource] = useState<Source>('tasks');
  return <>
    <Tabs<Source> value={source} onChange={setSource} options={[{ value: 'tasks', label: '运营任务' }, { value: 'itinerary', label: '旅游团行程提醒' }, { value: 'daily', label: '每日推送' }]} />
    {source === 'tasks' && <TaskList presetContentId={presetContentId} onPresetUsed={onPresetUsed} />}
    {source === 'itinerary' && <ItineraryPanel />}
    {source === 'daily' && <DailyPushPanel />}
  </>;
}

function TaskList({ presetContentId, onPresetUsed }: { presetContentId?: string; onPresetUsed: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [tasks, error, reload] = useLoad(() => call('task.list', {}), []);
  const [creating, setCreating] = useState(Boolean(presetContentId));
  const [runsOf, setRunsOf] = useState<OpsTask | null>(null);
  const { busy, notice, run } = useAction();
  const list = (tasks ?? []).filter(task => filter === 'all' || task.status === filter);
  const count = (status: TaskStatus) => (tasks ?? []).filter(task => task.status === status).length;
  const act = (action: () => Promise<unknown>, message: string) => void run(async () => { await action(); await reload(); return message; });

  return <>
    <Card title="运营任务" extra={<div className="inline-actions"><button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button><button className="primary" onClick={() => setCreating(true)}>创建任务</button></div>}>
      <Tabs<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部', count: tasks?.length }, ...(['pending', 'running', 'success', 'failed', 'cancelled'] as TaskStatus[]).map(status => ({ value: status, label: TASK_STATUS_LABELS[status], count: count(status) }))]} />
      <Notice notice={notice} />
      {error && <p className="notice error">{error}</p>}
      {list.length ? <table className="ops-table">
        <thead><tr><th>时间</th><th>内容</th><th>群</th><th>执行方式</th><th>状态</th><th className="right">操作</th></tr></thead>
        <tbody>{list.map(task => <tr key={task.id}>
          <td className="mono">{task.status === 'pending' ? formatTime(task.nextRunAt) : formatTime(task.lastRunAt ?? task.runAt)}<small>{task.status === 'pending' ? '下次执行' : task.lastRunAt ? '上次执行' : '计划时间'}</small></td>
          <td><strong>{task.contentTitle}</strong>{task.weatherCity && <small>附 {task.weatherCity} 天气</small>}</td>
          <td>{task.groupNames.join('、') || '—'}</td>
          <td>{TASK_REPEAT_LABELS[task.repeat]}</td>
          <td><Pill tone={TONE[task.status]}>{TASK_STATUS_LABELS[task.status]}</Pill>{task.lastResult && <small className={task.status === 'failed' ? 'danger-text' : ''}>{task.lastResult}</small>}</td>
          <td className="right actions-cell">
            {task.status === 'pending' && <button className="link" disabled={busy} onClick={() => void run(async () => { const result = await call('task.runNow', { id: task.id }); await reload(); if (result.status === 'failed' || result.lastResult?.startsWith('失败')) throw new Error(`执行失败：${result.lastResult ?? ''}，详情见运行日志`); return `执行完成：${result.lastResult ?? ''}`; })}>立即执行</button>}
            {task.status === 'failed' && <button className="link" disabled={busy} onClick={() => act(() => call('task.retry', { id: task.id }), '已开始重试')}>重试</button>}
            {(task.status === 'pending' || task.status === 'failed') && <button className="link" disabled={busy} onClick={() => act(() => call('task.cancel', { id: task.id }), '任务已取消')}>取消</button>}
            <button className="link" onClick={() => setRunsOf(task)}>记录</button>
            {task.status !== 'running' && <button className="link danger-text" disabled={busy} onClick={() => { if (window.confirm('确定删除这个任务吗？')) act(() => call('task.delete', { id: task.id }), '任务已删除'); }}>删除</button>}
          </td>
        </tr>)}</tbody>
      </table> : tasks && <Empty action={<button className="secondary" onClick={() => setCreating(true)}>创建任务</button>}>{filter === 'all' ? '还没有运营任务。' : `没有${TASK_STATUS_LABELS[filter as TaskStatus]}的任务。`}</Empty>}
    </Card>
    {creating && <TaskForm presetContentId={presetContentId} onClose={() => { setCreating(false); onPresetUsed(); }} onCreated={async () => { setCreating(false); onPresetUsed(); await reload(); }} />}
    {runsOf && <RunsDialog task={runsOf} onClose={() => setRunsOf(null)} />}
  </>;
}

function TaskForm({ presetContentId, onClose, onCreated }: { presetContentId?: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const [contents] = useLoad(async () => (await call('content.list', {})).filter(piece => ['approved', 'scheduled', 'sent'].includes(piece.status)), []);
  const [groups, groupError] = useLoad(() => call('group.list'), []);
  const [contentId, setContentId] = useState(presetContentId ?? '');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [runAt, setRunAt] = useState(() => toLocalInput(new Date(Date.now() + 10 * 60 * 1000)));
  const [repeat, setRepeat] = useState<TaskRepeat>('once');
  const [weatherCity, setWeatherCity] = useState('');
  const { busy, notice, run } = useAction();
  const usable = (groups ?? []).filter(group => group.enabled && group.available);
  const preview = contents?.find(piece => piece.id === contentId);
  const toggle = (id: string) => setGroupIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));

  return <Modal title="创建运营任务" onClose={onClose} wide>
    <Field label="内容" hint="只能选择审核通过的内容">
      <select value={contentId} onChange={event => setContentId(event.target.value)}>
        <option value="">选择内容…</option>
        {contents?.map(piece => <option key={piece.id} value={piece.id}>{piece.title}（{piece.channel}）</option>)}
      </select>
    </Field>
    {preview && <div className="preview-box"><p>{preview.body}</p></div>}
    <Field group label={`发送群（已选 ${groupIds.length} 个）`}>
      {usable.length ? <div className="group-list">{usable.map(group => <button key={group.id} className={`group-card ${groupIds.includes(group.id) ? 'selected' : ''}`} onClick={() => toggle(group.id)}>
        <span className="group-avatar">{group.channel === 'bot' ? '群' : '客'}</span>
        <span className="group-meta"><strong>{group.name}</strong><small>{GROUP_CHANNEL_LABELS[group.channel]}{group.channel === 'customer' ? ' · 需群主确认' : ''}</small></span>
        <span className="group-check">{groupIds.includes(group.id) ? '✓' : ''}</span>
      </button>)}</div> : <p className="hint">{groupError || '没有可用的群。请先到“群管理”刷新群列表并启用群。'}</p>}
    </Field>
    <div className="form-grid">
      <Field label={repeat === 'once' ? '发送时间' : '首次发送时间'}><input type="datetime-local" value={runAt} onChange={event => setRunAt(event.target.value)} /></Field>
      <Field label="附加天气预报（可选）" hint="填城市名，发送时在文末附上当天天气"><input value={weatherCity} placeholder="例如：北京" onChange={event => setWeatherCity(event.target.value)} /></Field>
    </div>
    <Field group label="执行方式">
      <div className="radio-row">{(Object.keys(TASK_REPEAT_LABELS) as TaskRepeat[]).map(value => <label key={value} className="toggle-row"><input type="radio" checked={repeat === value} onChange={() => setRepeat(value)} />{TASK_REPEAT_LABELS[value]}</label>)}</div>
    </Field>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !contentId || !groupIds.length || !runAt} onClick={() => void run(async () => { await call('task.create', { contentId, groupIds, runAt: new Date(runAt).toISOString(), repeat, weatherCity }); await onCreated(); })}>创建任务</button>
    </div>
  </Modal>;
}

function RunsDialog({ task, onClose }: { task: OpsTask; onClose: () => void }) {
  const [runs] = useLoad(() => call('task.runs', { id: task.id }), [task.id]);
  return <Modal title={`执行记录：${task.contentTitle}`} onClose={onClose} wide>
    {runs?.length ? <table className="ops-table"><tbody>{runs.map(item => <tr key={item.id}>
      <td className="mono">{formatTime(item.startedAt)}</td>
      <td><Pill tone={item.status === 'success' ? 'ok' : 'fail'}>{item.status === 'success' ? '成功' : item.status === 'skipped' ? '已错过' : '失败'}</Pill></td>
      <td className="pre">{item.detail}</td>
    </tr>)}</tbody></table> : <Empty>还没有执行过。</Empty>}
  </Modal>;
}
