import React, { useEffect, useState } from 'react';
import type { ItineraryJobStatus, ItineraryParseResult, ItinerarySettings, ItineraryView } from './domain/business';

const SAMPLE = '群名\t日期\t时间\t地点\t事项\t城市\t单独发送\n云南7日游-1008团\t10月8日\t07:30\t酒店大堂\t集合出发\t昆明\t是\n云南7日游-1008团\t10月8日\t10:00\t石林景区\t游览石林\t昆明\t\n云南7日游-1008团\t10月9日\t08:00\t大理古城\t自由活动\t大理\t';

const STATUS_TEXT: Record<ItineraryJobStatus, string> = {
  scheduled: '待发送', due: '即将发送', created: '已发送', confirmed: '已发送', unconfirmed: '已发送',
  'dry-run': '干跑已生成', failed: '失败', expired: '已过期', unmatched: '群名未匹配',
};

function formatTime(iso: string) { const date = new Date(iso); return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

export function ItineraryPanel() {
  const [view, setView] = useState<ItineraryView | null>(null);
  const [settings, setSettings] = useState<ItinerarySettings | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [parsed, setParsed] = useState<ItineraryParseResult | null>(null);
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const update = (patch: Partial<ItinerarySettings>) => setSettings(current => current ? { ...current, ...patch } : current);

  const applyView = (next: ItineraryView) => { setView(next); setSettings(next.settings); };
  const act = async (label: string, run: () => Promise<void>) => { setBusy(true); setHint(label); try { await run(); } finally { setBusy(false); } };

  useEffect(() => {
    void window.travelbot.itinerary().then(applyView);
    const timer = setInterval(() => { void window.travelbot.itinerary().then(next => setView(next)); }, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const save = () => act('正在保存…', async () => {
    if (!settings) return;
    const result = await window.travelbot.saveItinerarySettings(settings);
    if (result.ok && result.view) { applyView(result.view); setHint(result.view.settings.enabled ? (result.view.settings.dryRun ? '已保存：干跑模式，到点只生成内容不发送' : '已保存：到点会通过 RPA 自动发到群里') : '已保存，行程提醒未启用'); }
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
  const runJob = (jobId: string) => act('正在发送…', async () => { const result = await window.travelbot.runItineraryJob(jobId); if (result.view) applyView(result.view); setHint(result.message); });

  if (!settings || !view) return <section className="card schedule-card"><div className="card-title"><span>行程提醒</span></div><p className="hint">加载中…</p></section>;
  const upcoming = view.jobs.filter(job => job.status !== 'expired');
  const alerts = view.jobs.filter(job => job.status === 'failed');
  return <section className="card schedule-card test-card groupmsg-card itinerary-card">
    <div className="card-title"><span>行程提醒</span><span className="tiny">按旅游团行程自动发到群里</span></div>
    <p className="hint">每个群在出行前一天晚上收到一条“明日行程 + 天气”；勾选“单独发送”的节点会在开始前再单独提醒。到点通过 RPA 直接发到群里，群名对应“群管理”里的群。发送时间要在防封设置的发送时段内。程序需要保持运行（可最小化到托盘），电脑不能锁屏。</p>

    <div className="channel-row">
      <label className="toggle-row"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />启用行程提醒</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.dryRun} onChange={e => update({ dryRun: e.target.checked })} />干跑模式（只生成内容，不发送）</label>
      <label className="toggle-row"><input type="checkbox" checked={settings.includeWeather} onChange={e => update({ includeWeather: e.target.checked })} />附带天气预报</label>
    </div>
    <div className="schedule-grid">
      <div><label>每日行程发送时间（出行前一天）</label><input type="time" value={settings.digestTime} onChange={e => update({ digestTime: e.target.value })} /></div>
      <div><label>单独提醒提前（分钟）</label><input type="number" min="0" value={settings.reminderLeadMinutes} onChange={e => update({ reminderLeadMinutes: Number(e.target.value) })} /></div>
    </div>
    <label>消息落款（可选）</label>
    <input value={settings.footer} placeholder="例如：XX 旅行 · 有问题随时在群里找导游" onChange={e => update({ footer: e.target.value })} />
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
    {alerts.length > 0 && <div className="confirm-box warn-box"><strong>{alerts.length} 条任务需要关注</strong><p>{alerts.map(job => `${job.groupName} · ${formatTime(job.dueAt)} · ${STATUS_TEXT[job.status]}${job.record?.error ? `：${job.record.error}` : ''}`).join('\n')}</p></div>}

    {view.items.length > 0 && <>
      <div className="card-title sub-title"><span>已录入行程（{view.items.length}）</span><button className="secondary" onClick={() => void remove({ beforeToday: true })} disabled={busy}>清除已结束的行程</button></div>
      <div className="table-wrap"><table className="itinerary-table"><thead><tr><th>群名</th><th>日期</th><th>时间</th><th>事项</th><th>地点</th><th>单独发送</th><th /></tr></thead><tbody>
        {view.items.map(item => <tr key={item.id}><td>{item.groupName}</td><td>{item.date}</td><td>{item.time || '全天'}</td><td>{item.activity}</td><td>{item.place}{item.city ? `（${item.city}）` : ''}</td><td><input type="checkbox" checked={item.separate} disabled={busy || !item.time} onChange={e => void toggleSeparate(item.id, e.target.checked)} /></td><td><button className="link" onClick={() => void remove({ ids: [item.id] })} disabled={busy}>删除</button></td></tr>)}
      </tbody></table></div>
    </>}

    {upcoming.length > 0 && <>
      <div className="card-title sub-title"><span>发送计划（{upcoming.length}）</span></div>
      <div className="table-wrap"><table className="itinerary-table"><thead><tr><th>发送时间</th><th>群</th><th>类型</th><th>内容</th><th>状态</th><th /></tr></thead><tbody>
        {upcoming.map(job => <tr key={job.id}><td>{formatTime(job.dueAt)}</td><td>{job.groupName}</td><td>{job.kind === 'digest' ? `${job.date.slice(5)} 每日行程` : '单独提醒'}</td><td>{job.summary}</td><td className={`job-status ${job.status}`} title={job.matchError || job.record?.error || ''}>{STATUS_TEXT[job.status]}</td><td className="row-actions"><button className="link" onClick={() => void showPreview(job.id, `${job.groupName} · ${job.kind === 'digest' ? '每日行程' : '单独提醒'}`)} disabled={busy}>预览</button>{!['created', 'confirmed', 'unconfirmed', 'dry-run'].includes(job.status) && <button className="link" onClick={() => void runJob(job.id)} disabled={busy}>立即发送</button>}</td></tr>)}
      </tbody></table></div>
    </>}

    {hint && <p className="hint">{hint}</p>}
    {preview && <div className="preview-box"><strong>{preview.title}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{preview.content}</p></div>}
    {view.lastResult && <p className="hint">最近一次：{view.lastResult}</p>}
  </section>;
}
