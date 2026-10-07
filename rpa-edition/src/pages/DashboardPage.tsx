import React from 'react';
import { call, formatTime } from '../api';
import { TASK_STATUS_LABELS } from '../domain/ops';
import { Card, Empty, Pill, useLoad } from '../ui';
import type { PageKey } from '../App';

const TONE = { pending: 'warn', running: 'info', success: 'ok', failed: 'fail', cancelled: 'muted', skipped: 'fail' } as const;

/** 首页：只读汇总，不创建、不生成、不发送。 */
export function DashboardPage({ go }: { go: (page: PageKey) => void }) {
  const [data, error, reload] = useLoad(() => call('dashboard.get'), []);
  if (!data) return <Card>{error ? <p className="notice error">{error}</p> : <p className="hint">加载中…</p>}</Card>;
  const stats: Array<{ label: string; value: number; tone: string; page: PageKey }> = [
    { label: '待审核', value: data.reviewing, tone: 'warn', page: 'content' },
    { label: '今日待发送', value: data.pendingToday, tone: 'info', page: 'tasks' },
    { label: '今日成功', value: data.successToday, tone: 'ok', page: 'tasks' },
    { label: '今日失败', value: data.failedToday, tone: 'fail', page: 'logs' },
  ];
  return <>
    <div className="stat-grid">{stats.map(stat => <button key={stat.label} className={`stat-card tone-${stat.tone}`} onClick={() => go(stat.page)}><small>{stat.label}</small><b>{stat.value}</b></button>)}</div>
    <div className="dash-grid">
      <Card title="今日运营任务" extra={<button className="refresh-button" onClick={() => void reload()} title="刷新"><span>↻</span></button>}>
        {data.todayTasks.length ? <table className="ops-table">
          <tbody>{data.todayTasks.map((task, index) => <tr key={`${task.taskId}-${index}`}>
            <td className="mono">{formatTime(task.time, false)}</td>
            <td><strong>{task.title}</strong><small>{task.groupNames.join('、')}</small></td>
            <td className="right"><Pill tone={TONE[task.status]}>{task.status === 'skipped' ? '已错过' : task.status === 'pending' ? '待发送' : TASK_STATUS_LABELS[task.status]}</Pill></td>
          </tr>)}</tbody>
        </table> : <Empty action={<button className="secondary" onClick={() => go('tasks')}>去创建运营任务</button>}>今天还没有运营任务。</Empty>}
      </Card>
      <Card title="最近路线" extra={<button className="link" onClick={() => go('routes')}>全部路线</button>}>
        {data.recentRoutes.length ? <div className="mini-list">{data.recentRoutes.map(route => <button key={route.id} className="mini-item" onClick={() => go('routes')}>
          <strong>{route.name}</strong><small>{[route.city, `${route.days}天`, ...route.tags].filter(Boolean).join(' · ')}</small>
        </button>)}</div> : <Empty action={<button className="secondary" onClick={() => go('routes')}>新建路线</button>}>还没有路线。</Empty>}
      </Card>
    </div>
    <Card title="快速开始">
      <div className="flow">
        {([['materials', '① 素材库', '整理景点、酒店、餐厅、攻略'], ['routes', '② 路线管理', '把素材编排成几天的行程'], ['content', '③ 内容中心', '生成文案并人工审核'], ['tasks', '④ 运营任务', '定时把内容发到群里']] as Array<[PageKey, string, string]>).map(([page, title, desc]) =>
          <button key={page} className="flow-step" onClick={() => go(page)}><strong>{title}</strong><small>{desc}</small></button>)}
      </div>
    </Card>
  </>;
}
