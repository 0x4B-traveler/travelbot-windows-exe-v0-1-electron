import React, { useState } from 'react';
import { call, formatTime, toLocalInput } from '../api';
import { TASK_REPEAT_LABELS, TASK_STATUS_LABELS, type SamplePlanResult, type DryRunReport, type OpsTask, type TaskInput, type TaskRepeat, type TaskStatus } from '../domain/ops';
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
  const [planning, setPlanning] = useState(false);
  const [runsOf, setRunsOf] = useState<OpsTask | null>(null);
  const [report, setReport] = useState<DryRunReport | null>(null);
  const { busy, notice, run } = useAction();
  const list = (tasks ?? []).filter(task => filter === 'all' || task.status === filter);
  const count = (status: TaskStatus) => (tasks ?? []).filter(task => task.status === status).length;
  const act = (action: () => Promise<unknown>, message: string) => void run(async () => { await action(); await reload(); return message; });

  return <>
    <Card title="运营任务" extra={<div className="inline-actions"><button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button><button className="secondary" onClick={() => setPlanning(true)}>生成测试排期</button><button className="primary" onClick={() => setCreating(true)}>创建任务</button></div>}>
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
            {task.status !== 'running' && <button className="link" disabled={busy} title="走一遍发送流程，但不真正发出" onClick={() => void run(async () => { setReport(await call('task.dryRun', { id: task.id })); })}>预演</button>}
            <button className="link" onClick={() => setRunsOf(task)}>记录</button>
            {task.status !== 'running' && <button className="link danger-text" disabled={busy} onClick={() => { if (window.confirm('确定删除这个任务吗？')) act(() => call('task.delete', { id: task.id }), '任务已删除'); }}>删除</button>}
          </td>
        </tr>)}</tbody>
      </table> : tasks && <Empty action={<button className="secondary" onClick={() => setCreating(true)}>创建任务</button>}>{filter === 'all' ? '还没有运营任务。' : `没有${TASK_STATUS_LABELS[filter as TaskStatus]}的任务。`}</Empty>}
    </Card>
    {creating && <TaskForm presetContentId={presetContentId} onClose={() => { setCreating(false); onPresetUsed(); }} onCreated={async () => { setCreating(false); onPresetUsed(); await reload(); }} />}
    {runsOf && <RunsDialog task={runsOf} onClose={() => setRunsOf(null)} />}
    {report && <DryRunDialog report={report} onClose={() => setReport(null)} />}
    {planning && <SamplePlanForm onClose={() => setPlanning(false)} onCreated={async message => { setPlanning(false); await reload(); await run(async () => message); }} />}
  </>;
}

/** 用云南示例路线给选中的群排一周测试任务（每天轮换路线，一周内每个群收到全部路线）。 */
function SamplePlanForm({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => Promise<void> }) {
  const [groups, groupError] = useLoad(() => call('group.list'), []);
  const usable = (groups ?? []).filter(group => group.enabled && group.available);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const [startDate, setStartDate] = useState(toLocalInput(tomorrow).slice(0, 10));
  const [days, setDays] = useState(7);
  const [startTime, setStartTime] = useState('08:30');
  const [intervalMinutes, setIntervalMinutes] = useState(35);
  const { busy, notice, run } = useAction();
  const slots = Math.min(6, usable.length);
  const format = (result: SamplePlanResult) => `已生成 ${result.tasks} 个任务：${result.groups} 个群，每天约 ${result.sendsPerDay} 次发送，${formatTime(result.firstAt)} 开始，最后一个 ${formatTime(result.lastAt)}。`;

  return <Modal title="生成测试排期（云南示例数据）" onClose={onClose}>
    <p className="hint">把全部可用的 {usable.length} 个群分成 {slots} 组，每组在自己的时段收一条示例路线群文案（附该路线城市天气），每天轮换路线，6 天内每个群都会收到全部 6 条路线、覆盖所有景点。需要先在素材库导入云南示例数据。</p>
    {groupError && <p className="notice error">{groupError}</p>}
    <div className="form-grid">
      <Field label="开始日期"><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></Field>
      <Field label="天数"><input type="number" min={1} max={14} value={days} onChange={event => setDays(Number(event.target.value))} /></Field>
      <Field label="每天第一次发送"><input type="time" value={startTime} onChange={event => setStartTime(event.target.value)} /></Field>
      <Field label="各组间隔（分钟）" hint="默认 35 分钟，配合“每小时最多 10 条”"><input type="number" min={10} max={240} value={intervalMinutes} onChange={event => setIntervalMinutes(Number(event.target.value))} /></Field>
    </div>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !usable.length} onClick={() => void run(async () => {
        if (!window.confirm(`将为 ${usable.length} 个群创建 ${slots * days} 个任务，到时间会真实发送。确定吗？`)) return '';
        await onCreated(format(await call('sample.planWeek', { name: 'yunnan', groupIds: usable.map(group => group.id), startDate, days, startTime, intervalMinutes })));
      })}>生成</button>
    </div>
  </Modal>;
}

function TaskForm({ presetContentId, onClose, onCreated }: { presetContentId?: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const [contents] = useLoad(async () => (await call('content.list', {})).filter(piece => ['approved', 'scheduled', 'sent'].includes(piece.status)), []);
  const [groups, groupError] = useLoad(() => call('group.list'), []);
  const [contentId, setContentId] = useState(presetContentId ?? '');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [runAt, setRunAt] = useState(() => toLocalInput(new Date(Date.now() + 10 * 60 * 1000)));
  const [repeat, setRepeat] = useState<TaskRepeat>('once');
  const [weatherCity, setWeatherCity] = useState('');
  const [report, setReport] = useState<DryRunReport | null>(null);
  const { busy, notice, run } = useAction();
  const input = (): TaskInput => ({ contentId, groupIds, runAt: new Date(runAt).toISOString(), repeat, weatherCity });
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
        <span className="group-avatar">群</span>
        <span className="group-meta"><strong>{group.name}</strong><small>RPA 直接发送</small></span>
        <span className="group-check">{groupIds.includes(group.id) ? '✓' : ''}</span>
      </button>)}</div> : <p className="hint">{groupError || '没有可用的群。请先到“群管理”按群名添加群。'}</p>}
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
      <button className="secondary" disabled={busy || !contentId || !groupIds.length} title="走一遍发送流程，但不真正发出" onClick={() => void run(async () => { setReport(await call('task.dryRun', input())); })}>预演</button>
      <button className="primary" disabled={busy || !contentId || !groupIds.length || !runAt} onClick={() => void run(async () => { await call('task.create', input()); await onCreated(); })}>创建任务</button>
    </div>
    {report && <DryRunDialog report={report} onClose={() => setReport(null)} />}
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

function DryRunDialog({ report, onClose }: { report: DryRunReport; onClose: () => void }) {
  const passed = report.groups.filter(group => group.ok).length;
  return <Modal title={`预演：${report.contentTitle}`} onClose={onClose} wide>
    <p className={`notice ${report.ok ? 'ok' : 'error'}`}>{report.ok ? `全部 ${report.groups.length} 个群检查通过。` : `${report.groups.length} 个群中 ${passed} 个检查通过，其余正式执行时会失败。`}这次是预演，没有发出任何消息。</p>
    <table className="ops-table compact"><thead><tr><th>群</th><th>结果</th></tr></thead>
      <tbody>{report.groups.map((group, index) => <tr key={index}>
        <td><strong>{group.name}</strong></td>
        <td><Pill tone={group.ok ? 'ok' : 'fail'}>{group.ok ? '通过' : '不通过'}</Pill><small>{group.detail}</small></td>
      </tr>)}</tbody>
    </table>
    <Field label="将要发送的完整内容"><div className="preview-box"><p className="pre">{report.text}</p></div></Field>
  </Modal>;
}
