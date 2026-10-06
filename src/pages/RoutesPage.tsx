import React, { useMemo, useState } from 'react';
import { call } from '../api';
import { CONTENT_CHANNELS, MATERIAL_KIND_LABELS, type ContentChannel, type Material, type Route, type RouteInput, type RouteQuery } from '../domain/ops';
import { Card, Empty, Field, Modal, Notice, Pill, splitTags, useAction, useLoad } from '../ui';

type DraftItem = RouteInput['items'][number];
const emptyRoute = (): RouteInput => ({ name: '', city: '', days: 1, tags: [], summary: '', status: 'enabled', items: [] });

/** 路线管理：只负责“怎么玩”，素材从素材库引用，文案交给内容中心。 */
export function RoutesPage({ onGenerated }: { onGenerated: () => void }) {
  const [query, setQuery] = useState<RouteQuery>({});
  const [text, setText] = useState('');
  const [routes, error, reload] = useLoad(() => call('route.list', query), [query]);
  const [editing, setEditing] = useState<RouteInput | null>(null);
  const cities = useMemo(() => [...new Set((routes ?? []).map(route => route.city).filter(Boolean))].sort(), [routes]);

  if (editing) return <RouteEditor input={editing} onClose={async () => { setEditing(null); await reload(); }} onGenerated={onGenerated} />;

  return <Card title={`路线（${routes?.length ?? 0}）`} extra={<button className="primary" onClick={() => setEditing(emptyRoute())}>新建路线</button>}>
    <div className="filter-row">
      <input value={text} placeholder="搜索路线名称、简介、标签" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setQuery({ ...query, text }); }} />
      <select value={query.city ?? ''} onChange={event => setQuery({ ...query, city: event.target.value || undefined })}><option value="">全部城市</option>{cities.map(city => <option key={city}>{city}</option>)}</select>
      <select value={query.days ?? ''} onChange={event => setQuery({ ...query, days: Number(event.target.value) || undefined })}><option value="">全部天数</option>{[1, 2, 3, 4, 5, 6, 7].map(day => <option key={day} value={day}>{day} 天</option>)}</select>
      <button className="secondary" onClick={() => setQuery({ ...query, text })}>搜索</button>
    </div>
    {error && <p className="notice error">{error}</p>}
    {routes?.length ? <div className="route-list">{routes.map(route => <button key={route.id} className="route-card" onClick={() => setEditing(toInput(route))}>
      <div><strong>{route.name}</strong><small>{[route.city, `${route.days}天`, ...route.tags].filter(Boolean).join(' | ')}</small></div>
      <div className="route-meta"><span>{route.items.length} 个行程节点</span><Pill tone={route.status === 'enabled' ? 'ok' : 'muted'}>{route.status === 'enabled' ? '启用' : '停用'}</Pill></div>
    </button>)}</div> : routes && <Empty action={<button className="secondary" onClick={() => setEditing(emptyRoute())}>新建第一条路线</button>}>还没有路线。</Empty>}
  </Card>;
}

function toInput(route: Route): RouteInput {
  return { id: route.id, name: route.name, city: route.city, days: route.days, tags: route.tags, summary: route.summary, status: route.status, items: route.items };
}

function RouteEditor({ input, onClose, onGenerated }: { input: RouteInput; onClose: () => Promise<void>; onGenerated: () => void }) {
  const [draft, setDraft] = useState(input);
  const [tags, setTags] = useState(input.tags.join('，'));
  const [generating, setGenerating] = useState(false);
  const [materials] = useLoad(() => call('material.list', {}), []);
  const { busy, notice, run } = useAction();
  const dayCount = Math.max(1, draft.days, ...draft.items.map(item => item.day));
  const byId = new Map((materials ?? []).map(material => [material.id, material]));

  const setItems = (items: DraftItem[]) => setDraft({ ...draft, items });
  const update = (index: number, patch: Partial<DraftItem>) => setItems(draft.items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const addItem = (day: number) => setItems([...draft.items, { day, time: '', title: '', note: '' }]);
  const removeDay = (day: number) => setDraft({ ...draft, days: Math.max(1, dayCount - 1), items: draft.items.filter(item => item.day !== day).map(item => (item.day > day ? { ...item, day: item.day - 1 } : item)) });
  const save = async () => {
    const saved = await call('route.save', { ...draft, days: dayCount, tags: splitTags(tags) });
    setDraft(toInput(saved)); setTags(saved.tags.join('，'));
    return saved;
  };

  return <>
    <div className="crumb"><button className="link" onClick={() => void onClose()}>← 返回路线列表</button></div>
    <Card title={draft.id ? draft.name || '编辑路线' : '新建路线'} extra={draft.id && <button className="link danger-text" onClick={() => { if (window.confirm(`确定删除路线“${draft.name}”吗？`)) void run(async () => { await call('route.delete', { id: draft.id! }); await onClose(); }); }}>删除路线</button>}>
      <div className="form-grid">
        <Field label="路线名称"><input value={draft.name} placeholder="例如：北京古北水镇2日游" onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="城市"><input value={draft.city} placeholder="出发 / 目的地城市" onChange={event => setDraft({ ...draft, city: event.target.value })} /></Field>
        <Field label="标签" hint="用逗号分隔"><input value={tags} placeholder="亲子，周末" onChange={event => setTags(event.target.value)} /></Field>
        <Field label="状态"><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as RouteInput['status'] })}><option value="enabled">启用</option><option value="disabled">停用</option></select></Field>
      </div>
      <Field label="路线简介"><textarea value={draft.summary} placeholder="一两句话介绍这条路线的亮点" onChange={event => setDraft({ ...draft, summary: event.target.value })} /></Field>
    </Card>

    {Array.from({ length: dayCount }, (_, index) => index + 1).map(day => {
      const rows = draft.items.map((item, index) => ({ item, index })).filter(row => row.item.day === day);
      return <Card key={day} title={`Day ${day}`} extra={<div className="inline-actions">{dayCount > 1 && <button className="link danger-text" onClick={() => removeDay(day)}>删除这一天</button>}<button className="secondary" onClick={() => addItem(day)}>＋ 添加行程</button></div>}>
        {rows.length ? <div className="itinerary-editor">{rows.map(({ item, index }) => <div className="itinerary-row" key={index}>
          <input className="time" value={item.time} placeholder="09:00" onChange={event => update(index, { time: event.target.value })} />
          <input className="title" value={item.title} placeholder="行程内容，例如：游览古北水镇" onChange={event => update(index, { title: event.target.value })} />
          <select className="material" value={item.materialId ?? ''} onChange={event => { const material = byId.get(event.target.value); update(index, { materialId: event.target.value || undefined, title: item.title || material?.title || '' }); }}>
            <option value="">关联素材（可选）</option>
            {(materials ?? []).map(material => <option key={material.id} value={material.id}>{MATERIAL_KIND_LABELS[material.kind]} · {material.title}{material.city ? `（${material.city}）` : ''}</option>)}
          </select>
          <input className="note" value={item.note} placeholder="备注" onChange={event => update(index, { note: event.target.value })} />
          <button className="link danger-text" onClick={() => setItems(draft.items.filter((_, i) => i !== index))}>删除</button>
        </div>)}</div> : <p className="hint">这一天还没有安排。</p>}
      </Card>;
    })}

    <div className="sticky-actions">
      <Notice notice={notice} />
      <button className="secondary" onClick={() => setDraft({ ...draft, days: dayCount + 1 })}>＋ 增加一天</button>
      <button className="secondary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await save(); setGenerating(true); })}>生成运营内容</button>
      <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => { await save(); return '路线已保存'; })}>保存</button>
    </div>

    {generating && draft.id && <GenerateDialog routeId={draft.id} routeName={draft.name} materials={materials ?? []} onClose={() => setGenerating(false)} onGenerated={onGenerated} />}
  </>;
}

function GenerateDialog({ routeId, routeName, onClose, onGenerated }: { routeId: string; routeName: string; materials: Material[]; onClose: () => void; onGenerated: () => void }) {
  const [channel, setChannel] = useState<ContentChannel>('群文案');
  const { busy, notice, run } = useAction();
  return <Modal title={`根据“${routeName}”生成运营内容`} onClose={onClose}>
    <p className="hint">生成的内容会作为草稿放进内容中心，人工修改、审核通过后才能排期发送。</p>
    <div className="chip-row">{CONTENT_CHANNELS.map(value => <button key={value} className={`chip ${channel === value ? 'active' : ''}`} onClick={() => setChannel(value)}>{value}</button>)}</div>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await call('content.generate', { routeId, channel }); onGenerated(); })}>生成并去审核</button></div>
  </Modal>;
}
