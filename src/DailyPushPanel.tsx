import React, { useEffect, useState } from 'react';
import type { CustomerGroup, DailyPushSettings, DailyPushView } from './domain/business';

const emptySettings: DailyPushSettings = { enabled: false, sendTime: '17:50', includeWeather: true, location: '', includeRecommendation: true, footer: '', ownerUserIds: [], targets: [], launchAtLogin: false };

function splitOwners(value: string) { return value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean); }

export function DailyPushPanel() {
  const [settings, setSettings] = useState<DailyPushSettings>(emptySettings);
  const [view, setView] = useState<DailyPushView | null>(null);
  const [ownersText, setOwnersText] = useState('');
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
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
    void Promise.all([window.travelbot.dailyPush(), window.travelbot.groupMessageConfig()]).then(([next, config]) => {
      applyView(next);
      const owners = next.ownerUserIds.length ? next.ownerUserIds : (config.senderUserId ? [config.senderUserId] : []);
      setOwnersText(owners.join(', '));
      if (owners.length && config.hasSecret) void loadGroups(owners);
    });
  }, []);

  const loadGroups = async (owners = splitOwners(ownersText)) => {
    setGroupsLoading(true);
    try {
      const result = await window.travelbot.dailyPushGroups(owners);
      setGroups(result.groups);
      setHint(result.ok ? (result.groups.length ? '' : '这些群主名下没有客户群') : (result.stderr || '客户群列表加载失败'));
    } finally { setGroupsLoading(false); }
  };
  const toggleGroup = (group: CustomerGroup) => update({ targets: selected(group.chatId) ? settings.targets.filter(target => target.chatId !== group.chatId) : [...settings.targets, { chatId: group.chatId, owner: group.owner, name: group.name }] });

  const save = async () => {
    setBusy(true); setHint('正在保存…');
    try {
      const result = await window.travelbot.saveDailyPush({ ...settings, ownerUserIds: splitOwners(ownersText) });
      if (result.ok && result.view) { applyView(result.view); setHint(result.view.enabled ? '已保存，到点会自动创建群发任务' : '已保存，每日推送未启用'); }
      else setHint(result.stderr || '保存失败');
    } finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setHint('正在生成预览…');
    try { const result = await window.travelbot.previewDailyPush(settings); setPreview(result.content ?? ''); setHint(result.ok ? '' : (result.stderr || '预览失败')); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setHint('正在创建今天的群发任务…');
    try { const result = await window.travelbot.runDailyPush(); if (result.content) setPreview(result.content); if (result.view) setView(result.view); setHint(result.message); }
    finally { setBusy(false); }
  };

  const owners = [...new Set(settings.targets.map(target => target.owner))];
  return <section className="card schedule-card test-card groupmsg-card">
    <div className="card-title"><span>每日客户群推送</span><span className="tiny">天气 + 今日推荐 · 每天一次</span></div>
    <p className="hint">每天到点后按群主各创建一个群发任务，群主在企业微信里点一次“发送”就会发到他名下选中的全部客户群。群发在群主确认的那一刻发出，建议把时间设在希望发出时间前 10 分钟左右。程序需要保持运行（可最小化到托盘）。</p>
    <label className="toggle-row"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />启用每日推送</label>
    <div className="schedule-grid">
      <div><label>每天创建任务的时间</label><input type="time" value={settings.sendTime} onChange={e => update({ sendTime: e.target.value })} /></div>
      <div><label>天气城市（12 点后发送时播报明天）</label><input value={settings.location} placeholder="例如：上海" onChange={e => update({ location: e.target.value })} /></div>
    </div>
    <div className="channel-row">
      <label className="toggle-row"><input type="checkbox" checked={settings.includeWeather} onChange={e => update({ includeWeather: e.target.checked })} />包含天气预报</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.includeRecommendation} onChange={e => update({ includeRecommendation: e.target.checked })} />包含今日推荐（从资料库按顺序轮换）</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.launchAtLogin} onChange={e => update({ launchAtLogin: e.target.checked })} />开机自动启动（最小化到托盘）</label>
    </div>
    <label>消息落款（可选）</label>
    <input value={settings.footer} placeholder="例如：XX 旅行 · 有问题随时在群里找我们" onChange={e => update({ footer: e.target.value })} />

    <label>群主 userid（多个用逗号分隔）</label>
    <div className="assistant-row"><input value={ownersText} onChange={e => setOwnersText(e.target.value)} /><button className="secondary" onClick={() => void loadGroups()} disabled={groupsLoading || !splitOwners(ownersText).length}>{groupsLoading ? '加载中…' : '加载客户群'}</button></div>
    {groups.length > 0 && <div className="group-list">{groups.map(group => <button className={`group-card ${selected(group.chatId) ? 'selected' : ''}`} key={group.chatId} onClick={() => toggleGroup(group)} disabled={busy}><span className="group-avatar">客</span><span className="group-meta"><strong>{group.name}</strong><small>群主 {group.owner} · {group.memberCount} 人</small></span><span className="group-check">{selected(group.chatId) ? '✓' : ''}</span></button>)}</div>}
    <p className="hint">已选 {settings.targets.length} 个客户群，每天需要 {owners.length} 位群主各确认一次。</p>

    <div className="inline-actions">
      <button className="secondary" onClick={() => void runPreview()} disabled={busy}>预览内容</button>
      <button className="secondary" onClick={() => void runNow()} disabled={busy || !settings.targets.length}>立即创建今天的任务</button>
      <button className="primary" onClick={() => void save()} disabled={busy}>保存设置</button>
    </div>
    {hint && <p className="hint">{hint}</p>}
    {preview && <div className="preview-box"><strong>推送内容预览</strong><p style={{ whiteSpace: 'pre-wrap' }}>{preview}</p></div>}
    {view && <p className="hint">
      {view.nextRunAt ? `下次创建任务：${new Date(view.nextRunAt).toLocaleString()}` : '每日推送未启用'}
      {view.state.lastResult && <><br />最近一次：{view.state.lastResult}</>}
    </p>}
  </section>;
}
