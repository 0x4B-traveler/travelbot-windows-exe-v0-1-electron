import React, { useEffect, useState } from 'react';
import type { ItineraryJobStatus, ItineraryParseResult, ItinerarySettings, ItineraryView } from './domain/business';

const SAMPLE = '群名\t日期\t时间\t地点\t事项\t城市\t单独发送\n云南7日游-1008团\t10月8日\t07:30\t酒店大堂\t集合出发\t昆明\t是\n云南7日游-1008团\t10月8日\t10:00\t石林景区\t游览石林\t昆明\t\n云南7日游-1008团\t10月9日\t08:00\t大理古城\t自由活动\t大理\t';

const STATUS_TEXT: Record<ItineraryJobStatus, string> = {
  scheduled: '待创建', due: '即将创建', created: '待群主确认', confirmed: '已发送', unconfirmed: '群主未确认',
  'dry-run': '干跑已生成', failed: '失败', expired: '已过期', unmatched: '群名未匹配',
};

function splitOwners(value: string) { return value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean); }
function formatTime(iso: string) { const date = new Date(iso); return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

export function ItineraryPanel() {
  const [view, setView] = useState<ItineraryView | null>(null);
  const [settings, setSettings] = useState<ItinerarySettings | null>(null);
  const [ownersText, setOwnersText] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [parsed, setParsed] = useState<ItineraryParseResult | null>(null);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const update = (patch: Partial<ItinerarySettings>) => setSettings(current => current ? { ...current, ...patch } : current);

  const applyView = (next: ItineraryView) => { setView(next); setSettings(next.settings); };
  const act = async (label: string, run: () => Promise<void>) => { setBusy(true); setHint(label); try { await run(); } finally { setBusy(false); } };

  useEffect(() => {
    void Promise.all([window.travelbot.itinerary(), window.travelbot.groupMessageConfig()]).then(([next, config]) => {
      applyView(next);
      const owners = next.settings.ownerUserIds.length ? next.settings.ownerUserIds : (config.senderUserId ? [config.senderUserId] : []);
      setOwnersText(owners.join(', '));
      // 打开面板时自动加载客户群，用于按群名匹配
      if (owners.length && config.hasSecret) void loadGroups(owners);
    });
    const timer = setInterval(() => { void window.travelbot.itinerary().then(next => setView(next)); }, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const loadGroups = (owners = splitOwners(ownersText)) => act('正在加载客户群…', async () => {
    const result = await window.travelbot.loadItineraryGroups(owners);
    if (result.ok && result.view) { applyView(result.view); setHint(`已加载 ${result.view.settings.groups.length} 个客户群`); }
    else setHint(result.stderr || '客户群列表加载失败');
  });
  const save = () => act('正在保存…', async () => {
    if (!settings) return;
    const result = await window.travelbot.saveItinerarySettings({ ...settings, ownerUserIds: splitOwners(ownersText) });
    if (result.ok && result.view) { applyView(result.view); setHint(result.view.settings.enabled ? (result.view.settings.dryRun ? '已保存：干跑模式，到点只生成内容不发送' : '已保存：到点会自动创建群发任务') : '已保存，行程群发未启用'); }
    else setHint(result.stderr || '保存失败');
  });
  const checkPaste = () => act('正在识别…', async () => { const result = await window.travelbot.parseItinerary(pasteText); setParsed(result); setHint(`识别到 ${result.items.length} 条行程${result.errors.length ? `，${result.errors.length} 行有问题` : ''}`); });
  const importPaste = (mode: 'append' | 'replace') => act('正在导入…', async () => {
    const result = await window.travelbot.importItinerary({ text: pasteText, mode });
    if (result.ok && result.view) { applyView(result.view); setPasteText(''); setParsed(null); setHint(`已导入 ${result.added} 条行程${result.errors?.length ? `，跳过 ${result.errors.length} 行：${result.errors.join('；')}` : ''}`); }
    else setHint(result.stderr || '导入失败');
  });
  const toggleSeparate = (id: string, separate: boolean) => act('', async () => { const result = await window.travelbot.updateItineraryItem({ id, patch: { separate } }); if (result.view) applyView(result.view); setHint(''); });
  const remove = (input: { ids?: string[]; groupName?: string; beforeToday?: boolean }) => act('正在删除…', async () => { const result = await window.travelbot.deleteItineraryItems(input); if (result.view) applyView(result.view); setHint('已删除'); });
  const showPreview = (jobId: string, title: string) => act('正在生成预览…', async () => { const result = await window.travelbot.previewItineraryJob(jobId); if (result.ok && result.content) { setPreview({ title, content: result.content }); setHint(''); } else setHint(result.stderr || '预览失败'); });
  const runJob = (jobId: string) => act('正在创建…', async () => { const result = await window.travelbot.runItineraryJob(jobId); if (result.view) applyView(result.view); setHint(result.message); });
  const checkConfirmations = () => act('正在查询群主确认状态…', async () => { const result = await window.travelbot.checkItineraryConfirmations(); if (result.view) applyView(result.view); setHint(result.ok ? `查询完成，新确认 ${result.confirmed ?? 0} 条` : (result.stderr || '查询失败')); });

  if (!settings || !view) return <section className="card schedule-card"><div className="card-title"><span>行程定时群发</span></div><p className="hint">加载中…</p></section>;
  const upcoming = view.jobs.filter(job => job.status !== 'expired');
  const alerts = view.jobs.filter(job => job.status === 'unconfirmed' || job.status === 'failed');
  return <section className="card schedule-card test-card groupmsg-card itinerary-card">
    <div className="card-title"><span>行程定时群发</span><span className="tiny">按旅游团行程自动创建客户群群发</span></div>
    <p className="hint">每个客户群在出行前一天晚上收到一条“明日行程 + 天气”；勾选“单独发送”的节点会在开始前再单独提醒。到点创建群发任务后，群主在企业微信里点“发送”才会发出。程序需要保持运行（可最小化到托盘）。</p>

    <div className="channel-row">
      <label className="toggle-row"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />启用行程群发</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.dryRun} onChange={e => update({ dryRun: e.target.checked })} />干跑模式（只生成内容，不调用企业微信）</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.includeWeather} onChange={e => update({ includeWeather: e.target.checked })} />附带天气预报</label>
    </div>
    <div className="schedule-grid">
      <div><label>每日行程创建时间（出行前一天）</label><input type="time" value={settings.digestTime} onChange={e => update({ digestTime: e.target.value })} /></div>
      <div><label>单独提醒提前（分钟）</label><input type="number" min="0" value={settings.reminderLeadMinutes} onChange={e => update({ reminderLeadMinutes: Number(e.target.value) })} /></div>
    </div>
    <label>消息落款（可选）</label>
    <input value={settings.footer} placeholder="例如：XX 旅行 · 有问题随时在群里找导游" onChange={e => update({ footer: e.target.value })} />
    <label>群主 userid（多个用逗号分隔，按这些群主加载客户群）</label>
    <div className="assistant-row"><input value={ownersText} onChange={e => setOwnersText(e.target.value)} /><button className="secondary" onClick={() => void loadGroups()} disabled={busy || !splitOwners(ownersText).length}>加载客户群</button></div>
    <p className="hint">{settings.groupsLoadedAt ? `已加载 ${settings.groups.length} 个客户群（${new Date(settings.groupsLoadedAt).toLocaleString()}），群名对不上时会自动重新加载` : '尚未加载客户群'}</p>
    <div className="inline-actions"><button className="primary" onClick={() => void save()} disabled={busy}>保存设置</button></div>

    <label>录入行程（可直接从 Excel 复制粘贴，首行可带表头）</label>
    <p className="hint">列顺序：群名、日期、时间、地点、事项、城市（可选，用于天气）、单独发送（填“是”）。</p>
    <textarea className="itinerary-paste" value={pasteText} placeholder={SAMPLE} onChange={e => { setPasteText(e.target.value); setParsed(null); }} disabled={busy} />
    <div className="inline-actions">
      <button className="secondary" onClick={() => setPasteText(SAMPLE)} disabled={busy}>填入示例</button>
      <button className="secondary" onClick={() => void checkPaste()} disabled={busy || !pasteText.trim()}>识别</button>
      <button className="secondary" onClick={() => void importPaste('replace')} disabled={busy || !pasteText.trim()}>替换全部行程</button>
      <button className="primary" onClick={() => void importPaste('append')} disabled={busy || !pasteText.trim()}>追加导入</button>
    </div>
    {parsed && <div className="preview-box"><strong>识别结果：{parsed.items.length} 条</strong>{parsed.errors.length > 0 && <p className="danger-text">{parsed.errors.join('\n')}</p>}{parsed.items.length > 0 && <p>{parsed.items.map(item => `${item.groupName} · ${item.date} ${item.time || '全天'} ${item.activity} ${item.place}${item.separate ? ' · 单独发送' : ''}`).join('\n')}</p>}</div>}

    {view.warnings.length > 0 && <div className="confirm-box warn-box"><strong>需要处理</strong><p>{view.warnings.join('\n')}</p></div>}
    {alerts.length > 0 && <div className="confirm-box warn-box"><strong>{alerts.length} 条任务需要关注</strong><p>{alerts.map(job => `${job.groupName} · ${formatTime(job.dueAt)} · ${STATUS_TEXT[job.status]}${job.record?.error ? `：${job.record.error}` : job.status === 'unconfirmed' ? `：请提醒群主 ${job.record?.owner ?? ''} 在企业微信群发助手里点“发送”` : ''}`).join('\n')}</p></div>}

    {view.items.length > 0 && <>
      <div className="card-title sub-title"><span>已录入行程（{view.items.length}）</span><button className="secondary" onClick={() => void remove({ beforeToday: true })} disabled={busy}>清除已结束的行程</button></div>
      <div className="table-wrap"><table className="itinerary-table"><thead><tr><th>群名</th><th>日期</th><th>时间</th><th>事项</th><th>地点</th><th>单独发送</th><th /></tr></thead><tbody>
        {view.items.map(item => <tr key={item.id}><td>{item.groupName}</td><td>{item.date}</td><td>{item.time || '全天'}</td><td>{item.activity}</td><td>{item.place}{item.city ? `（${item.city}）` : ''}</td><td><input type="checkbox" checked={item.separate} disabled={busy || !item.time} onChange={e => void toggleSeparate(item.id, e.target.checked)} /></td><td><button className="link" onClick={() => void remove({ ids: [item.id] })} disabled={busy}>删除</button></td></tr>)}
      </tbody></table></div>
    </>}

    {upcoming.length > 0 && <>
      <div className="card-title sub-title"><span>发送计划（{upcoming.length}）</span><button className="secondary" onClick={() => void checkConfirmations()} disabled={busy || settings.dryRun}>刷新确认状态</button></div>
      <div className="table-wrap"><table className="itinerary-table"><thead><tr><th>创建时间</th><th>客户群</th><th>类型</th><th>内容</th><th>状态</th><th /></tr></thead><tbody>
        {upcoming.map(job => <tr key={job.id}><td>{formatTime(job.dueAt)}</td><td>{job.groupName}</td><td>{job.kind === 'digest' ? `${job.date.slice(5)} 每日行程` : '单独提醒'}</td><td>{job.summary}</td><td className={`job-status ${job.status}`} title={job.matchError || job.record?.error || ''}>{STATUS_TEXT[job.status]}</td><td className="row-actions"><button className="link" onClick={() => void showPreview(job.id, `${job.groupName} · ${job.kind === 'digest' ? '每日行程' : '单独提醒'}`)} disabled={busy}>预览</button>{!['created', 'confirmed', 'unconfirmed', 'dry-run'].includes(job.status) && <button className="link" onClick={() => void runJob(job.id)} disabled={busy}>立即创建</button>}</td></tr>)}
      </tbody></table></div>
      <p className="hint">每个客户群每月最多接收“当月天数”条群发：{view.quota.map(entry => `${entry.groupName} ${entry.count}/${entry.limit}`).join('，')}</p>
    </>}

    {hint && <p className="hint">{hint}</p>}
    {preview && <div className="preview-box"><strong>{preview.title}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{preview.content}</p></div>}
    {view.lastResult && <p className="hint">最近一次：{view.lastResult}</p>}
  </section>;
}
