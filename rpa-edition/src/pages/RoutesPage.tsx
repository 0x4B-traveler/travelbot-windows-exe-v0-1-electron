import React, { useMemo, useState } from 'react';
import { call } from '../api';
import type { Material, Route, RouteDay, RouteInput, RouteQuery } from '../domain/ops';
import { Card, Empty, Field, Modal, Notice, Pill, splitTags, useAction, useLoad } from '../ui';

const emptyRoute = (): RouteInput => ({ name: '', tags: [], summary: '', status: 'enabled', dayPlans: [{ day: 1, city: '', plan: '', spotIds: [] }] });
const IMPORT_SAMPLE = '第几天\t城市\t行程\t酒店\t景点\n1\t昆明\t抵达昆明，下午翠湖公园自由活动\t昆明翠湖片区酒店\t翠湖公园\n2\t昆明\t石林风景区，傍晚动车前往大理\t大理古城客栈\t石林风景区\n3\t大理\t崇圣寺三塔、大理古城\t大理古城客栈\t崇圣寺三塔、大理古城';

/** 路线：素材库的核心。按天排：所在城市（查天气）、当天行程、当晚酒店、要发的景点攻略。 */
export function RoutesPanel() {
  const [query, setQuery] = useState<RouteQuery>({});
  const [text, setText] = useState('');
  const [routes, error, reload] = useLoad(() => call('route.list', query), [query]);
  const [editing, setEditing] = useState<RouteInput | null>(null);
  const cities = useMemo(() => [...new Set((routes ?? []).flatMap(route => route.dayPlans.map(day => day.city)).filter(Boolean))].sort(), [routes]);

  if (editing) return <RouteEditor input={editing} onClose={async () => { setEditing(null); await reload(); }} />;

  return <Card title={`路线（${routes?.length ?? 0}）`} extra={<button className="primary" onClick={() => setEditing(emptyRoute())}>新增路线</button>}>
    <div className="filter-row">
      <input value={text} placeholder="搜索路线名称、简介、标签" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setQuery({ ...query, text }); }} />
      <select value={query.city ?? ''} onChange={event => setQuery({ ...query, city: event.target.value || undefined })}><option value="">全部城市</option>{cities.map(city => <option key={city}>{city}</option>)}</select>
      <select value={query.days ?? ''} onChange={event => setQuery({ ...query, days: Number(event.target.value) || undefined })}><option value="">全部天数</option>{Array.from({ length: 12 }, (_, index) => index + 1).map(day => <option key={day} value={day}>{day} 天</option>)}</select>
      <button className="secondary" onClick={() => setQuery({ ...query, text })}>搜索</button>
    </div>
    {error && <p className="notice error">{error}</p>}
    {routes?.length ? <div className="route-list">{routes.map(route => <button key={route.id} className="route-card" onClick={() => setEditing(toInput(route))}>
      <div><strong>{route.name}</strong><small>{[`${route.days}天`, cleanCities(route).join(' → '), ...route.tags].filter(Boolean).join(' | ')}</small></div>
      <div className="route-meta"><span>{route.dayPlans.filter(day => day.hotelId).length} 晚有酒店 · {route.dayPlans.reduce((sum, day) => sum + day.spotIds.length, 0)} 个景点攻略</span><Pill tone={route.status === 'enabled' ? 'ok' : 'muted'}>{route.status === 'enabled' ? '启用' : '停用'}</Pill></div>
    </button>)}</div> : routes && <Empty action={<button className="secondary" onClick={() => setEditing(emptyRoute())}>新增第一条路线</button>}>还没有路线。路线是固定的几天行程，建好以后每个团选一条就行。</Empty>}
  </Card>;
}

function cleanCities(route: Route) { return route.dayPlans.map(day => day.city).filter((city, index, list) => city && city !== list[index - 1]); }

function toInput(route: Route): RouteInput {
  return { id: route.id, name: route.name, tags: route.tags, summary: route.summary, status: route.status, dayPlans: route.dayPlans };
}

function RouteEditor({ input, onClose }: { input: RouteInput; onClose: () => Promise<void> }) {
  const [draft, setDraft] = useState(input);
  const [tags, setTags] = useState(input.tags.join('，'));
  const [importing, setImporting] = useState(false);
  const [materials, , reloadMaterials] = useLoad(() => call('material.list', {}), []);
  const { busy, notice, run } = useAction();
  const hotels = (materials ?? []).filter(material => material.kind === 'hotel');
  const spots = (materials ?? []).filter(material => material.kind === 'spot' || material.kind === 'guide');
  const byId = new Map((materials ?? []).map(material => [material.id, material]));

  const setDays = (dayPlans: RouteDay[]) => setDraft({ ...draft, dayPlans: dayPlans.map((day, index) => ({ ...day, day: index + 1 })) });
  const update = (index: number, patch: Partial<RouteDay>) => setDays(draft.dayPlans.map((day, i) => (i === index ? { ...day, ...patch } : day)));
  const move = (index: number, offset: number) => { const list = [...draft.dayPlans]; const [item] = list.splice(index, 1); list.splice(index + offset, 0, item); setDays(list); };
  const addDay = () => { const last = draft.dayPlans[draft.dayPlans.length - 1]; setDays([...draft.dayPlans, { day: 0, city: last?.city ?? '', plan: '', spotIds: [] }]); };

  return <>
    <div className="crumb"><button className="link" onClick={() => void onClose()}>← 返回路线列表</button></div>
    <Card title={draft.id ? draft.name || '编辑路线' : '新增路线'} extra={draft.id && <button className="link danger-text" onClick={() => { if (window.confirm(`确定删除路线“${draft.name}”吗？`)) void run(async () => { await call('route.delete', { id: draft.id! }); await onClose(); }); }}>删除路线</button>}>
      <div className="form-grid">
        <Field label="路线名称"><input value={draft.name} placeholder="例如：云南昆明大理丽江6日游" onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="标签" hint="用逗号分隔"><input value={tags} placeholder="经典，亲子" onChange={event => setTags(event.target.value)} /></Field>
      </div>
      <div className="form-grid">
        <Field label="简介"><input value={draft.summary} placeholder="一句话介绍这条路线" onChange={event => setDraft({ ...draft, summary: event.target.value })} /></Field>
        <Field label="状态" hint="停用的路线新增团时选不到，已经在用的团照常发"><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as RouteInput['status'] })}><option value="enabled">启用</option><option value="disabled">停用</option></select></Field>
      </div>
    </Card>

    <Card title={`每天的安排（共 ${draft.dayPlans.length} 天）`} extra={<div className="inline-actions"><button className="secondary" onClick={() => setImporting(true)}>从 Excel 贴入</button><button className="secondary" onClick={addDay}>＋ 增加一天</button></div>}>
      <p className="hint">每天傍晚发的“明日提醒”用明天这一行的城市查天气、写行程；“酒店及周边TIPS”发当晚住的酒店；“景点游玩攻略”发明天这一行选的景点（一个景点一条，附攻略图）。酒店和景点在“酒店和景点”里录。</p>
      <div className="day-editor">
        <div className="day-row head"><span>天</span><span>城市</span><span>当天行程</span><span>当晚酒店</span><span>景点攻略</span><span /></div>
        {draft.dayPlans.map((day, index) => <div className="day-row" key={index}>
          <strong>第{day.day}天</strong>
          <input value={day.city} placeholder="昆明" onChange={event => update(index, { city: event.target.value })} />
          <textarea value={day.plan} placeholder="石林风景区，傍晚动车前往大理" onChange={event => update(index, { plan: event.target.value })} />
          <select value={day.hotelId ?? ''} onChange={event => update(index, { hotelId: event.target.value || undefined })}>
            <option value="">{index === draft.dayPlans.length - 1 ? '不住（最后一天）' : '不发酒店TIPS'}</option>
            {hotels.map(hotel => <option key={hotel.id} value={hotel.id}>{hotel.title}{hotel.city ? `（${hotel.city}）` : ''}</option>)}
          </select>
          <SpotPicker value={day.spotIds} options={spots} byId={byId} city={day.city} onChange={spotIds => update(index, { spotIds })} />
          <span className="row-actions">
            <button className="link" disabled={index === 0} onClick={() => move(index, -1)} title="上移">↑</button>
            <button className="link" disabled={index === draft.dayPlans.length - 1} onClick={() => move(index, 1)} title="下移">↓</button>
            <button className="link danger-text" disabled={draft.dayPlans.length === 1} onClick={() => setDays(draft.dayPlans.filter((_, i) => i !== index))}>删除</button>
          </span>
        </div>)}
      </div>
    </Card>

    <div className="sticky-actions">
      <Notice notice={notice} />
      <button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void run(async () => {
        const saved = await call('route.save', { ...draft, tags: splitTags(tags) });
        setDraft(toInput(saved)); setTags(saved.tags.join('，'));
        return '路线已保存，用这条路线的团按新内容发送';
      })}>保存</button>
    </div>
    {importing && <ImportDays onClose={() => setImporting(false)} onImported={async (dayPlans, message) => { setImporting(false); setDays(dayPlans); await reloadMaterials(); await run(async () => message); }} />}
  </>;
}

/** 景点攻略多选：已选的显示成标签，下拉里同城市的排前面。 */
function SpotPicker({ value, options, byId, city, onChange }: { value: string[]; options: Material[]; byId: Map<string, Material>; city: string; onChange: (value: string[]) => void }) {
  const rest = options.filter(option => !value.includes(option.id)).sort((a, b) => Number(b.city === city) - Number(a.city === city));
  return <div className="spot-picker">
    {value.map(id => <span className="chip active" key={id}>{byId.get(id)?.title ?? '（已删除）'}{byId.get(id) && byId.get(id)!.images.length === 0 && ' ⚠'}<button className="link" onClick={() => onChange(value.filter(item => item !== id))}>✕</button></span>)}
    <select value="" onChange={event => { if (event.target.value) onChange([...value, event.target.value]); }}>
      <option value="">{value.length ? '＋ 再加一个' : '选择景点（可多选）'}</option>
      {rest.map(option => <option key={option.id} value={option.id}>{option.title}{option.city ? `（${option.city}）` : ''}{option.images.length ? '' : ' · 没有攻略图'}</option>)}
    </select>
  </div>;
}

function ImportDays({ onClose, onImported }: { onClose: () => void; onImported: (dayPlans: RouteDay[], message: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const { busy, notice, run } = useAction();
  return <Modal title="从 Excel 贴入每天的安排" onClose={onClose} wide>
    <p className="hint">在 Excel 里选中表格（含表头）复制，粘贴到下面。表头：第几天、城市、行程、酒店、景点；一天有几个景点用顿号隔开。酒店和景点按名称找素材库里的，找不到的会新建一条空素材，之后到“酒店和景点”里补上介绍和攻略图。贴入后会替换编辑器里现在的安排，确认无误再保存。</p>
    <textarea className="tall mono-text" value={text} placeholder={IMPORT_SAMPLE} onChange={event => setText(event.target.value)} />
    <Notice notice={notice} />
    <div className="inline-actions end">
      <button className="secondary" onClick={() => setText(IMPORT_SAMPLE)}>填入示例</button>
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void run(async () => {
        const result = await call('route.parseDays', { text });
        const parts = [`已贴入 ${result.dayPlans.length} 天`];
        if (result.created.length) parts.push(`新建了 ${result.created.length} 条素材（${result.created.join('、')}），记得补介绍和攻略图`);
        if (result.errors.length) parts.push(`有 ${result.errors.length} 处问题：${result.errors.join('；')}`);
        await onImported(result.dayPlans, `${parts.join('；')}。确认后点“保存”。`);
      })}>贴入</button>
    </div>
  </Modal>;
}
