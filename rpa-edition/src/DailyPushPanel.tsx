import React, { useEffect, useState } from 'react';
import type { DailyPushSettings, DailyPushView } from './domain/business';
import type { OpsGroup } from './domain/ops';
import { call } from './api';

const emptySettings: DailyPushSettings = { enabled: false, sendTime: '17:50', includeWeather: true, location: '', includeRecommendation: true, footer: '', targets: [], launchAtLogin: false };

export function DailyPushPanel() {
  const [settings, setSettings] = useState<DailyPushSettings>(emptySettings);
  const [view, setView] = useState<DailyPushView | null>(null);
  const [groups, setGroups] = useState<OpsGroup[]>([]);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const selected = (chatId: string) => settings.targets.some(target => target.chatId === chatId);
  const update = (patch: Partial<DailyPushSettings>) => setSettings(current => ({ ...current, ...patch }));

  const applyView = (next: DailyPushView) => {
    setView(next);
    const { state: _state, nextRunAt: _next, ...stored } = next;
    setSettings(stored);
  };

  useEffect(() => {
    void window.travelbot.dailyPush().then(applyView);
    void call('group.list').then(list => setGroups(list.filter(group => group.enabled))).catch(error => setHint(error?.message || '群列表加载失败'));
  }, []);

  const toggleGroup = (group: OpsGroup) => update({ targets: selected(group.id) ? settings.targets.filter(target => target.chatId !== group.id) : [...settings.targets, { chatId: group.id, owner: '', name: group.name }] });
  // 群管理里已删除或停用的群
  const missing = settings.targets.filter(target => !groups.some(group => group.id === target.chatId));

  const save = async () => {
    setBusy(true); setHint('正在保存…');
    try {
      const result = await window.travelbot.saveDailyPush(settings);
      if (result.ok && result.view) { applyView(result.view); setHint(result.view.enabled ? '已保存，到点会通过 RPA 自动发到选中的群' : '已保存，每日推送未启用'); }
      else setHint(result.stderr || '保存失败');
    } finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setHint('正在生成预览…');
    try { const result = await window.travelbot.previewDailyPush(settings); setPreview(result.content ?? ''); setHint(result.ok ? '' : (result.stderr || '预览失败')); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setHint('正在发送今天的推送，群与群之间会随机间隔…');
    try { const result = await window.travelbot.runDailyPush(); if (result.content) setPreview(result.content); if (result.view) setView(result.view); setHint(result.message); }
    finally { setBusy(false); }
  };

  return <section className="card schedule-card test-card groupmsg-card">
    <div className="card-title"><span>每日群推送</span><span className="tiny">天气 + 今日推荐 · 每天一次</span></div>
    <p className="hint">每天到点后通过 RPA 依次发到选中的群，群与群之间按防封设置随机间隔，失败的群会自动重试。发送时间要在防封设置的发送时段内。程序需要保持运行（可最小化到托盘），电脑不能锁屏。</p>
    <label className="toggle-row"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />启用每日推送</label>
    <div className="schedule-grid">
      <div><label>每天发送时间</label><input type="time" value={settings.sendTime} onChange={e => update({ sendTime: e.target.value })} /></div>
      <div><label>天气城市（12 点后发送时播报明天）</label><input value={settings.location} placeholder="例如：上海" onChange={e => update({ location: e.target.value })} /></div>
    </div>
    <div className="channel-row">
      <label className="toggle-row"><input type="checkbox" checked={settings.includeWeather} onChange={e => update({ includeWeather: e.target.checked })} />包含天气预报</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.includeRecommendation} onChange={e => update({ includeRecommendation: e.target.checked })} />包含今日推荐（从资料库按顺序轮换）</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.launchAtLogin} onChange={e => update({ launchAtLogin: e.target.checked })} />开机自动启动（最小化到托盘）</label>
    </div>
    <label>消息落款（可选）</label>
    <input value={settings.footer} placeholder="例如：XX 旅行 · 有问题随时在群里找我们" onChange={e => update({ footer: e.target.value })} />

    <label>发送到哪些群（来自群管理）</label>
    {groups.length > 0 ? <div className="group-list">{groups.map(group => <button className={`group-card ${selected(group.id) ? 'selected' : ''}`} key={group.id} onClick={() => toggleGroup(group)} disabled={busy}><span className="group-avatar">群</span><span className="group-meta"><strong>{group.name}</strong><small>RPA 直接发送</small></span><span className="group-check">{selected(group.id) ? '✓' : ''}</span></button>)}</div> : <p className="hint">群管理里还没有启用的群，请先到“群管理”按群名添加。</p>}
    <p className="hint">已选 {settings.targets.length} 个群。{missing.length ? `其中 ${missing.map(target => `“${target.name}”`).join('、')} 已在群管理里删除或停用，发送时会失败。` : ''}</p>

    <div className="inline-actions">
      <button className="secondary" onClick={() => void runPreview()} disabled={busy}>预览内容</button>
      <button className="secondary" onClick={() => void runNow()} disabled={busy || !settings.targets.length}>立即发送今天的推送</button>
      <button className="primary" onClick={() => void save()} disabled={busy}>保存设置</button>
    </div>
    {hint && <p className="hint">{hint}</p>}
    {preview && <div className="preview-box"><strong>推送内容预览</strong><p style={{ whiteSpace: 'pre-wrap' }}>{preview}</p></div>}
    {view && <p className="hint">
      {view.nextRunAt ? `下次发送：${new Date(view.nextRunAt).toLocaleString()}` : '每日推送未启用'}
      {view.state.lastResult && <><br />最近一次：{view.state.lastResult}</>}
    </p>}
  </section>;
}
