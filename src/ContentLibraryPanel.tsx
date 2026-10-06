import React, { useEffect, useState } from 'react';
import { CONTENT_KIND_LABELS, type ContentItem, type ContentKind, type NaturalLanguageCommand } from './domain/business';

const KINDS = Object.keys(CONTENT_KIND_LABELS) as ContentKind[];
type Draft = { id?: string; kind: ContentKind; title: string; body: string; location: string; tags: string };
const EMPTY: Draft = { kind: 'spot', title: '', body: '', location: '', tags: '' };

export function ContentLibraryPanel() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [kind, setKind] = useState<ContentKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hint, setHint] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [assistantHint, setAssistantHint] = useState('');
  const [pendingCommand, setPendingCommand] = useState<NaturalLanguageCommand | null>(null);

  const load = async () => {
    const result = await window.travelbot.contentSearch({ query, kind: kind === 'all' ? undefined : kind });
    setItems(result.items ?? []);
    if (!result.ok) setHint(result.stderr || '素材加载失败');
  };
  useEffect(() => { void load(); }, [kind]);

  const edit = (item: ContentItem) => setDraft({ id: item.id, kind: item.kind, title: item.title, body: item.body, location: item.location ?? '', tags: item.tags.join('，') });
  const save = async () => {
    if (!draft) return;
    const result = await window.travelbot.contentSave({ id: draft.id, kind: draft.kind, title: draft.title, body: draft.body, location: draft.location, tags: draft.tags.split(/[,，\s]+/) });
    if (!result.ok) { setHint(result.stderr || '保存失败'); return; }
    setHint(draft.id ? '素材已更新' : '素材已添加'); setDraft(null); await load();
  };
  const remove = async (item: ContentItem) => {
    if (!window.confirm(`确定删除素材「${item.title}」吗？`)) return;
    const result = await window.travelbot.contentDelete(item.id);
    setHint(result.ok ? '素材已删除' : (result.stderr || '删除失败'));
    if (draft?.id === item.id) setDraft(null);
    await load();
  };
  const copy = async (item: ContentItem) => { await navigator.clipboard.writeText(`${item.title}\n${item.body}`.trim()); setHint(`已复制「${item.title}」`); };

  const runAssistant = async () => {
    setAssistantHint('正在理解你的请求…');
    const result = await window.travelbot.contentCommand(assistantText);
    if (!result.ok) { setAssistantHint(result.stderr || '处理失败'); return; }
    if (result.command?.intent === 'search') { setPendingCommand(null); setQuery(result.command.query === '全部内容' ? '' : result.command.query); setItems((result.items as ContentItem[]) ?? []); setAssistantHint(`查询完成：找到 ${result.items?.length ?? 0} 条素材`); return; }
    if (result.command?.intent === 'unknown') { setAssistantHint(result.command.reason); return; }
    setPendingCommand(result.command ?? null); setAssistantHint('这个操作会修改本地素材，请确认后执行');
  };
  const confirmAssistant = async (confirmed: boolean) => {
    if (!pendingCommand) return;
    const result = await window.travelbot.contentConfirm({ command: pendingCommand, confirmed });
    setAssistantHint(result.ok ? '操作已完成' : (result.stderr || '操作未完成')); setPendingCommand(null); await load();
  };

  return <>
    <section className="card schedule-card">
      <div className="card-title"><span>素材列表</span><button className="primary" onClick={() => setDraft({ ...EMPTY, kind: kind === 'all' ? 'spot' : kind })}>＋ 新增素材</button></div>
      <div className="chip-row">
        <button className={`chip ${kind === 'all' ? 'active' : ''}`} onClick={() => setKind('all')}>全部</button>
        {KINDS.map(value => <button key={value} className={`chip ${kind === value ? 'active' : ''}`} onClick={() => setKind(value)}>{CONTENT_KIND_LABELS[value]}</button>)}
      </div>
      <div className="assistant-row"><input value={query} placeholder="按标题、内容、地点、标签搜索" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void load(); }} /><button className="secondary" onClick={() => void load()}>搜索</button></div>
      {hint && <p className="hint">{hint}</p>}
      {draft && <div className="editor-box">
        <strong>{draft.id ? '编辑素材' : '新增素材'}</strong>
        <div className="schedule-grid">
          <div><label>类型</label><select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as ContentKind })}>{KINDS.map(value => <option key={value} value={value}>{CONTENT_KIND_LABELS[value]}</option>)}</select></div>
          <div><label>标题</label><input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="例如：石林景区游览须知" /></div>
        </div>
        <div className="schedule-grid">
          <div><label>地点 / 城市</label><input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} placeholder="例如：昆明" /></div>
          <div><label>标签（逗号分隔）</label><input value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} placeholder="例如：亲子，必去" /></div>
        </div>
        <label>内容</label>
        <textarea className="tall" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} placeholder="素材正文，群发或每日推荐时会使用这段文字" />
        <div className="inline-actions end"><button className="secondary" onClick={() => setDraft(null)}>取消</button><button className="primary" onClick={() => void save()} disabled={!draft.title.trim()}>保存</button></div>
      </div>}
      {items.length ? <div className="item-list">{items.map(item => <div className="item-card" key={item.id}>
        <div className="item-head"><span className="kind-badge">{CONTENT_KIND_LABELS[item.kind] ?? item.kind}</span><strong>{item.title}</strong>{item.location && <span className="tiny">📍 {item.location}</span>}</div>
        {item.body && <p className="item-body">{item.body}</p>}
        <div className="item-foot">
          <span className="tiny">{item.tags.map(tag => `#${tag}`).join(' ')}</span>
          <span className="row-actions"><button className="link" onClick={() => void copy(item)}>复制</button><button className="link" onClick={() => edit(item)}>编辑</button><button className="link danger-text" onClick={() => void remove(item)}>删除</button></span>
        </div>
      </div>)}</div> : <p className="hint">暂无素材。点击右上角「新增素材」添加景点、餐厅、酒店、线路或攻略，每日推送会轮流推荐这些内容。</p>}
    </section>
    <section className="card schedule-card">
      <div className="card-title"><span>素材助手</span><span className="tiny">自然语言</span></div>
      <p className="hint">可以输入“查询上海”“新增一条迪士尼攻略”“删除迪士尼攻略”等命令，修改素材前需要确认。</p>
      <div className="assistant-row"><input value={assistantText} placeholder="输入素材查询或管理指令" onChange={e => setAssistantText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runAssistant(); }} /><button className="primary" onClick={() => void runAssistant()} disabled={!assistantText.trim()}>执行</button></div>
      {pendingCommand && <div className="confirm-box"><strong>确认执行：{pendingCommand.intent}</strong><p>{'title' in pendingCommand ? `${pendingCommand.title}：${pendingCommand.body}` : 'query' in pendingCommand ? pendingCommand.query : pendingCommand.reason}</p><div className="inline-actions"><button className="secondary" onClick={() => void confirmAssistant(false)}>取消</button><button className="primary" onClick={() => void confirmAssistant(true)}>确认执行</button></div></div>}
      {assistantHint && <p className="hint">{assistantHint}</p>}
    </section>
  </>;
}
