import React, { useState } from 'react';
import { call } from '../api';
import type { LogEntry, LogModule, LogQuery, LogStatus } from '../domain/ops';
import { Card, Empty, Modal, Pill, useLoad } from '../ui';

const MODULES: Array<[LogModule, string]> = [['Plan', '发送计划'], ['RPA', 'RPA'], ['Tour', '团'], ['Group', '群'], ['Content', '素材'], ['Scheduler', '调度'], ['System', '系统'], ['Task', '旧版任务'], ['Itinerary', '旧版行程提醒'], ['DailyPush', '旧版每日推送']];
const MODULE_LABEL = Object.fromEntries(MODULES) as Record<LogModule, string>;
const STATUS: Record<LogStatus, { tone: 'ok' | 'fail' | 'info'; text: string }> = { ok: { tone: 'ok', text: '✓' }, fail: { tone: 'fail', text: '✕' }, info: { tone: 'info', text: '·' } };

/** 运行日志：只读，用来排查问题，不修改任何业务数据。 */
export function LogsPage() {
  const [query, setQuery] = useState<LogQuery>({ limit: 300 });
  const [logs, error, reload] = useLoad(() => call('log.list', query), [query]);
  const [open, setOpen] = useState<LogEntry | null>(null);
  return <>
    <Card title="运行日志" extra={<button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button>}>
      <div className="filter-row">
        <select value={query.module ?? ''} onChange={event => setQuery({ ...query, module: (event.target.value || undefined) as LogModule | undefined })}><option value="">全部模块</option>{MODULES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={query.status ?? ''} onChange={event => setQuery({ ...query, status: (event.target.value || undefined) as LogStatus | undefined })}><option value="">全部结果</option><option value="ok">成功</option><option value="fail">失败</option><option value="info">信息</option></select>
        {query.taskId && <button className="chip active" onClick={() => setQuery({ ...query, taskId: undefined })}>只看一组 ✕</button>}
      </div>
      {error && <p className="notice error">{error}</p>}
      {logs?.length ? <table className="ops-table clickable compact">
        <thead><tr><th>时间</th><th>模块</th><th>操作</th><th>群</th><th>结果</th></tr></thead>
        <tbody>{logs.map(entry => <tr key={entry.id} onClick={() => setOpen(entry)}>
          <td className="mono">{new Date(entry.time).toLocaleString('zh-CN', { hour12: false })}</td>
          <td>{MODULE_LABEL[entry.module] ?? entry.module}</td><td>{entry.action}</td><td>{entry.groupName ?? '—'}</td>
          <td><Pill tone={STATUS[entry.status].tone}>{STATUS[entry.status].text}</Pill> <span className={entry.status === 'fail' ? 'danger-text' : ''}>{entry.message}</span></td>
        </tr>)}</tbody>
      </table> : logs && <Empty>暂无日志。</Empty>}
    </Card>
    {open && <Modal title="日志详情" onClose={() => setOpen(null)} wide>
      <dl className="detail-grid">
        <dt>时间</dt><dd>{new Date(open.time).toLocaleString('zh-CN', { hour12: false })}</dd>
        <dt>模块</dt><dd>{MODULE_LABEL[open.module] ?? open.module}</dd>
        <dt>操作</dt><dd>{open.action}</dd>
        <dt>结果</dt><dd>{open.status === 'ok' ? '成功' : open.status === 'fail' ? '失败' : '信息'}：{open.message}</dd>
        {open.groupName && <><dt>群</dt><dd>{open.groupName}</dd></>}
        {open.taskId && <><dt>编号</dt><dd className="mono">{open.taskId} <button className="link" onClick={() => { setQuery({ ...query, taskId: open.taskId }); setOpen(null); }}>只看这一组</button></dd></>}
        {open.attempt && <><dt>第几次执行</dt><dd>{open.attempt}</dd></>}
        {open.detail && <><dt>详细信息</dt><dd className="pre mono">{open.detail}</dd></>}
      </dl>
    </Modal>}
  </>;
}
