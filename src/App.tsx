import React, { useEffect, useState } from 'react';
import { DashboardPage } from './pages/DashboardPage';
import { MaterialsPage } from './pages/MaterialsPage';
import { RoutesPage } from './pages/RoutesPage';
import { ContentPage } from './pages/ContentPage';
import { TasksPage } from './pages/TasksPage';
import { GroupsPage } from './pages/GroupsPage';
import { LogsPage } from './pages/LogsPage';
import { checkAuth, SettingsPage, type ConnectionState } from './pages/SettingsPage';
import { EDITION } from './edition';
import { EDITION_LABELS } from './domain/ops';

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
const SETTINGS = { key: 'settings' as const, icon: '⚙', label: '设置', desc: EDITION === 'rpa' ? '机器人授权、RPA 发送、防封和账号池' : '机器人授权和客户群群发接口配置' };

export function App() {
  const [page, setPage] = useState<PageKey>('home');
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [presetContentId, setPresetContentId] = useState<string | undefined>();
  useEffect(() => { void checkAuth().then(result => setConnection(result.state)).catch(() => setConnection('error')); }, []);
  const current = MENU.find(item => item.key === page) ?? SETTINGS;
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  return <div className="layout">
    <aside className="sidebar">
      <div className="brand"><div className="logo">旅</div><div><strong>旅游运营助手</strong><span className="eyebrow">TRAVEL OPS · {EDITION_LABELS[EDITION]}</span></div></div>
      <nav>{MENU.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => setPage(item.key)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav>
      <button className={`sidebar-status ${connection === 'authorized' ? 'authorized' : connection}`} onClick={() => setPage('settings')}><i />{connection === 'authorized' ? '企业微信已连接' : connection === 'checking' ? '正在检查连接…' : '企业微信未连接'}</button>
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
      {page === 'settings' && <SettingsPage connection={connection} onConnectionChange={setConnection} />}
    </main>
  </div>;
}
