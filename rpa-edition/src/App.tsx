import React, { useEffect, useState } from 'react';
import { DashboardPage } from './pages/DashboardPage';
import { MaterialsPage } from './pages/MaterialsPage';
import { RoutesPage } from './pages/RoutesPage';
import { ContentPage } from './pages/ContentPage';
import { TasksPage } from './pages/TasksPage';
import { GroupsPage } from './pages/GroupsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { call } from './api';
import { RPA_CLIENT_LABELS, type PoolRole, type RpaClient } from './domain/ops';

export type PageKey = 'home' | 'materials' | 'routes' | 'content' | 'tasks' | 'groups' | 'logs' | 'settings';

const MENU: Array<{ key: PageKey; icon: string; label: string; desc: string }> = [
  { key: 'home', icon: '⌂', label: '首页', desc: '今日运营概况' },
  { key: 'materials', icon: '▤', label: '素材库', desc: '景点、酒店、餐厅、攻略等基础素材' },
  { key: 'routes', icon: '✈', label: '路线管理', desc: '把素材编排成每天的行程' },
  { key: 'content', icon: '✎', label: '内容中心', desc: '生成运营文案，人工编辑和审核' },
  { key: 'tasks', icon: '⏱', label: '运营任务', desc: '什么时候、把什么内容、发给谁' },
  { key: 'groups', icon: '◎', label: '群管理', desc: '维护可发送的群，测试发送能力' },
  { key: 'logs', icon: '☰', label: '运行日志', desc: '执行记录和错误排查' },
];
const SETTINGS = { key: 'settings' as const, icon: '⚙', label: '设置', desc: 'RPA 发送、防封和账号池' };

export function App() {
  const [page, setPage] = useState<PageKey>('home');
  const [sender, setSender] = useState<{ client: RpaClient; role: PoolRole } | null>(null);
  const [presetContentId, setPresetContentId] = useState<string | undefined>();
  useEffect(() => { void call('settings.getSend').then(value => setSender({ client: value.rpa.client, role: value.pool.role })).catch(() => setSender(null)); }, [page]);
  const current = MENU.find(item => item.key === page) ?? SETTINGS;
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  return <div className="layout">
    <aside className="sidebar">
      <div className="brand"><div className="logo">旅</div><div><strong>旅游运营助手</strong><span className="eyebrow">TRAVEL OPS · RPA 版</span></div></div>
      <nav>{MENU.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => setPage(item.key)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav>
      <button className={`sidebar-status ${sender ? 'authorized' : 'checking'}`} onClick={() => setPage('settings')}><i />{sender ? `${sender.role === 'agent' ? '执行端 · ' : ''}${RPA_CLIENT_LABELS[sender.client]}客户端发送` : '正在读取设置…'}</button>
    </aside>
    <main className="content">
      <header className="topbar">
        <div><h1>{current.label}</h1><p>{current.desc}</p></div>
        <div className="topbar-right"><span className="today">今日 {today}</span><button className={`icon-button ${page === 'settings' ? 'active' : ''}`} title="设置" onClick={() => setPage('settings')}>⚙ 设置</button></div>
      </header>
      {page === 'home' && <DashboardPage go={setPage} />}
      {page === 'materials' && <MaterialsPage />}
      {page === 'routes' && <RoutesPage onGenerated={() => setPage('content')} />}
      {page === 'content' && <ContentPage onSchedule={contentId => { setPresetContentId(contentId); setPage('tasks'); }} />}
      {page === 'tasks' && <TasksPage presetContentId={presetContentId} onPresetUsed={() => setPresetContentId(undefined)} />}
      {page === 'groups' && <GroupsPage />}
      {page === 'logs' && <LogsPage />}
      {page === 'settings' && <SettingsPage />}
    </main>
  </div>;
}
