import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { addDays, localDateText, resolveAccount, shortDate, TOUR_PHASE_LABELS, TOUR_STATE_LABELS, type OpsGroup, type Route, type SendBatch, type SendSettings, type TourInput } from '../domain/ops';
import { BatchPill, PreviewModal } from '../plan-ui';
import { Card, Empty, Field, Modal, Notice, Pill, Tabs, useAction, useLoad } from '../ui';

type Filter = 'active' | 'ended' | 'all';

/** 群管理：一个群对应一个团（群名 + 出发日期 + 路线），状态按日期自动算，团结束后留在列表里、不再发。 */
export function GroupsPage() {
  const [groups, error, reload] = useLoad(() => call('group.list'), []);
  const [routes] = useLoad(() => call('route.list', {}), []);
  const [send] = useLoad(() => call('settings.getSend'), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');
  const multiAccount = (send?.pool.accounts.length ?? 0) > 1;
  const isEnded = (group: OpsGroup) => group.phase === 'ended' || group.tour?.state === 'cancelled';
  const list = (groups ?? []).filter(group => filter === 'all' || (filter === 'ended' ? isEnded(group) : !isEnded(group)));
  const open = groups?.find(group => group.id === openId) ?? null;

  return <>
    <Card title="群和团" extra={<button className="primary" onClick={() => setAdding(true)}>新增团</button>}>
      <p className="hint">一个群只对应一个团，下一批客人建新群。状态按出发日期和路线天数自动算：出发前一天傍晚开始发，最后一天不再发，团结束后群留在列表里、不再发任何消息。</p>
      <Tabs<Filter> value={filter} onChange={setFilter} options={[
        { value: 'active', label: '待出发和进行中', count: groups?.filter(group => !isEnded(group)).length },
        { value: 'ended', label: '已结束', count: groups?.filter(isEnded).length },
        { value: 'all', label: '全部', count: groups?.length },
      ]} />
      {error && <p className="notice error">{error}</p>}
      {list.length ? <table className="ops-table clickable">
        <thead><tr><th>群名称</th><th>路线</th><th>出发 — 结束</th><th>状态</th>{multiAccount && <th>发送账号</th>}<th>今日发送</th></tr></thead>
        <tbody>{list.map(group => <tr key={group.id} onClick={() => setOpenId(group.id)}>
          <td><strong>{group.name}</strong>{group.tour?.note && <small>{group.tour.note}</small>}</td>
          <td>{group.routeName ?? '—'}</td>
          <td className="mono">{group.tour ? `${shortDate(group.tour.startDate)} — ${shortDate(group.endDate ?? '')}` : '—'}</td>
          <td><PhasePill group={group} /></td>
          {multiAccount && <td>{accountName(send, group)}</td>}
          <td>{group.todaySent}</td>
        </tr>)}</tbody>
      </table> : groups && <Empty action={<button className="secondary" onClick={() => setAdding(true)}>新增团</button>}>{filter === 'ended' ? '还没有结束的团。' : '还没有团。新增时填群名、出发日期和路线。'}</Empty>}
    </Card>
    {open && <GroupDetail group={open} routes={routes ?? []} send={send} onClose={() => setOpenId(null)} onChanged={reload} onDeleted={async () => { setOpenId(null); await reload(); }} />}
    {adding && <AddTour routes={routes ?? []} send={send} onClose={() => setAdding(false)} onAdded={async group => { setAdding(false); await reload(); setOpenId(group.id); }} />}
  </>;
}

function PhasePill({ group }: { group: OpsGroup }) {
  if (!group.enabled) return <Pill tone="muted">群已停用</Pill>;
  if (group.tour?.state === 'cancelled') return <Pill tone="muted">已取消</Pill>;
  if (group.tour?.state === 'paused') return <Pill tone="warn">已暂停</Pill>;
  const tone = group.phase === 'ongoing' ? 'ok' : group.phase === 'upcoming' ? 'info' : 'muted';
  return <Pill tone={tone}>{TOUR_PHASE_LABELS[group.phase]}{group.phase === 'ongoing' ? ` 第${group.dayNo}/${group.tourDays}天` : ''}</Pill>;
}

function accountName(send: SendSettings | null, group: OpsGroup) {
  if (!send) return '—';
  const account = resolveAccount(send.pool, group.accountId);
  return account ? `${account.name}${group.accountId ? '' : '（默认）'}` : '无可用账号';
}

/** 新增团：群名、路线、出发日期（天数跟路线走，不填结束日期）。 */
function AddTour({ routes, send, onClose, onAdded }: { routes: Route[]; send: SendSettings | null; onClose: () => void; onAdded: (group: OpsGroup) => Promise<void> }) {
  const usable = routes.filter(route => route.status === 'enabled');
  const [name, setName] = useState('');
  const [routeId, setRouteId] = useState(usable[0]?.id ?? '');
  const [startDate, setStartDate] = useState(addDays(localDateText(new Date()), 1));
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const { busy, notice, run } = useAction();
  const route = usable.find(item => item.id === routeId);
  return <Modal title="新增团" onClose={onClose}>
    <Field label="群名称" hint="和企业微信里显示的群名完全一致，发送时按群名搜索"><input value={name} onChange={event => setName(event.target.value)} placeholder="云南6日游 10月12日团" autoFocus /></Field>
    <Field label="路线">{usable.length ? <select value={routeId} onChange={event => setRouteId(event.target.value)}>{usable.map(item => <option key={item.id} value={item.id}>{item.name}（{item.days}天）</option>)}</select> : <p className="hint">还没有路线，请先到“素材库 → 路线”新增。</p>}</Field>
    <Field label="出发日期" hint={route ? `共 ${route.days} 天，${shortDate(addDays(startDate, route.days - 1))}结束；${shortDate(addDays(startDate, -1))}傍晚开始发` : undefined}><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></Field>
    {send && send.pool.accounts.length > 1 && <Field label="发送账号" hint="这个群由哪个管家的企业微信发"><AccountSelect send={send} value={accountId} onChange={setAccountId} /></Field>}
    <Field label="备注（可选）"><input value={note} onChange={event => setNote(event.target.value)} placeholder="比如导游、人数，只给自己看" /></Field>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="secondary" onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !name.trim() || !routeId || !startDate} onClick={() => void run(async () => { await onAdded(await call('group.add', { name, accountId: accountId || undefined, tour: { routeId, startDate, note } })); })}>新增</button>
    </div>
  </Modal>;
}

function GroupDetail({ group, routes, send, onClose, onChanged, onDeleted }: { group: OpsGroup; routes: Route[]; send: SendSettings | null; onClose: () => void; onChanged: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [tour, setTour] = useState<TourInput>(() => ({ routeId: group.tour?.routeId ?? routes.find(route => route.status === 'enabled')?.id ?? '', startDate: group.tour?.startDate ?? addDays(localDateText(new Date()), 1), hotelOverrides: group.tour?.hotelOverrides ?? {}, note: group.tour?.note ?? '' }));
  const [plan, , reloadPlan] = useLoad(() => call('plan.list', { groupId: group.id, from: addDays(localDateText(new Date()), -30), to: addDays(localDateText(new Date()), 30) }), [group.id, group.updatedAt]);
  const [hotels] = useLoad(async () => (await call('material.list', { kind: 'hotel' })), []);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<SendBatch | null>(null);
  const { busy, notice, run } = useAction();
  const route = routes.find(item => item.id === tour.routeId);
  const dirty = JSON.stringify(tour) !== JSON.stringify({ routeId: group.tour?.routeId ?? '', startDate: group.tour?.startDate ?? '', hotelOverrides: group.tour?.hotelOverrides ?? {}, note: group.tour?.note ?? '' });
  const act = (action: () => Promise<unknown>, done: string) => void run(async () => { await action(); await onChanged(); await reloadPlan(); return done; });
  const state = group.tour?.state ?? 'normal';
  const hotelName = (id?: string) => hotels?.find(hotel => hotel.id === id)?.title;

  return <Modal title={group.name} onClose={onClose} wide>
    <dl className="detail-grid">
      <dt>状态</dt><dd><PhasePill group={group} />{group.tour && state !== 'normal' && <span className="hint"> 团{TOUR_STATE_LABELS[state]}</span>}</dd>
      {group.tour && <><dt>行程</dt><dd>{group.routeName} · {shortDate(group.tour.startDate)} — {shortDate(group.endDate ?? '')}（{group.tourDays} 天）</dd></>}
      {send && send.pool.accounts.length > 1 && <><dt>发送账号</dt><dd><AccountSelect send={send} value={group.accountId ?? ''} onChange={value => act(() => call('group.update', { id: group.id, accountId: value }), '发送账号已更新，请确认这个账号在群里')} /></dd></>}
      <dt>最后发送</dt><dd>{formatTime(group.lastSentAt) || '—'}，今天发了 {group.todaySent} 次</dd>
    </dl>

    <h4 className="sub-title">团的信息</h4>
    <div className="form-grid">
      <Field label="路线"><select value={tour.routeId} onChange={event => setTour({ ...tour, routeId: event.target.value, hotelOverrides: {} })}><option value="">选择路线…</option>{routes.map(item => <option key={item.id} value={item.id}>{item.name}（{item.days}天）{item.status === 'disabled' ? ' · 已停用' : ''}</option>)}</select></Field>
      <Field label="出发日期" hint={route ? `${shortDate(addDays(tour.startDate, route.days - 1))}结束` : undefined}><input type="date" value={tour.startDate} onChange={event => setTour({ ...tour, startDate: event.target.value })} /></Field>
    </div>
    {route && <details className="override-box">
      <summary>按天换酒店（同一条路线不同期的团住的酒店可能不一样）{Object.keys(tour.hotelOverrides ?? {}).length ? `，已换 ${Object.keys(tour.hotelOverrides ?? {}).length} 晚` : ''}</summary>
      <table className="ops-table compact"><tbody>{route.dayPlans.map(day => {
        const override = tour.hotelOverrides?.[String(day.day)];
        return <tr key={day.day}>
          <td className="mono">第{day.day}晚 {shortDate(addDays(tour.startDate, day.day - 1))}</td><td>{day.city}</td>
          <td><select value={override === undefined ? '__route' : override} onChange={event => { const next = { ...(tour.hotelOverrides ?? {}) }; if (event.target.value === '__route') delete next[String(day.day)]; else next[String(day.day)] = event.target.value; setTour({ ...tour, hotelOverrides: next }); }}>
            <option value="__route">按路线：{hotelName(day.hotelId) ?? '不发'}</option>
            <option value="">这晚不发酒店TIPS</option>
            {(hotels ?? []).map(hotel => <option key={hotel.id} value={hotel.id}>{hotel.title}{hotel.city ? `（${hotel.city}）` : ''}</option>)}
          </select></td>
        </tr>;
      })}</tbody></table>
    </details>}
    <Field label="备注"><input value={tour.note ?? ''} onChange={event => setTour({ ...tour, note: event.target.value })} /></Field>
    <div className="inline-actions end">
      <button className="primary" disabled={busy || !dirty || !tour.routeId || !tour.startDate} onClick={() => {
        const moved = group.tour && (group.tour.startDate !== tour.startDate || group.tour.routeId !== tour.routeId);
        if (moved && !window.confirm('改了出发日期或路线，还没发的计划会按新日期重排，已经发出去的不重发。确定吗？')) return;
        act(() => call('group.update', { id: group.id, tour }), moved ? '已保存，发送计划已重排' : '已保存');
      }}>{group.tour ? '保存修改' : '绑定这个团'}</button>
    </div>

    {group.tour && <>
      <h4 className="sub-title">发送计划</h4>
      {plan?.length ? <table className="ops-table compact clickable"><tbody>{plan.map((batch, index) => <tr key={batch.id ?? index} onClick={() => batch.kind === 'evening' && setPreview(batch)}>
        <td className="mono">{shortDate(batch.date)}</td>
        <td>{batch.kind === 'oneoff' ? '临时消息' : batch.dayNo === 1 ? '出发前一天' : `明天第 ${batch.dayNo} 天`}<small>{batch.labels.join('、')}</small></td>
        <td><BatchPill status={batch.status} />{batch.lastResult && <small>{batch.lastResult}</small>}</td>
      </tr>)}</tbody></table> : <p className="hint">{plan ? '没有要发的。' : '加载中…'}</p>}
    </>}

    <h4 className="sub-title">临时发一条</h4>
    <p className="hint">比如“拼团未成功、升级独立成团”这样一次性的通知，点“发送”马上发。</p>
    <textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="消息内容" />
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <span className="inline-actions">
        {group.tour && state === 'normal' && <button className="secondary" disabled={busy} onClick={() => act(() => call('group.update', { id: group.id, state: 'paused' }), '已暂停，暂停期间不发')}>暂停发送</button>}
        {group.tour && state === 'paused' && <button className="secondary" disabled={busy} onClick={() => act(() => call('group.update', { id: group.id, state: 'normal' }), '已恢复，按日期继续发')}>恢复发送</button>}
        {group.tour && state !== 'cancelled' && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm(`取消“${group.name}”这个团？之后不再发任何消息，群留在列表里。`)) act(() => call('group.update', { id: group.id, state: 'cancelled' }), '团已取消'); }}>取消团</button>}
        {group.tour && state === 'cancelled' && <button className="secondary" disabled={busy} onClick={() => act(() => call('group.update', { id: group.id, state: 'normal' }), '已恢复')}>恢复这个团</button>}
        <button className="secondary" disabled={busy} onClick={() => act(() => call('group.update', { id: group.id, enabled: !group.enabled }), group.enabled ? '群已停用' : '群已启用')}>{group.enabled ? '停用群' : '启用群'}</button>
        <button className="link danger-text" disabled={busy} onClick={() => { if (window.confirm(`删除“${group.name}”和它的发送记录？`)) void run(async () => { await call('group.delete', { id: group.id }); await onDeleted(); }); }}>删除</button>
      </span>
      <button className="primary" disabled={busy || !group.enabled || !message.trim()} onClick={() => void run(async () => {
        if (!window.confirm(`把这条消息发到“${group.name}”？`)) return;
        const result = await call('group.sendMessage', { id: group.id, text: message });
        await onChanged(); await reloadPlan();
        if (result.status !== 'sent') throw new Error(result.lastResult ?? '没发出去，详见运行日志');
        setMessage('');
        return '已发出';
      })}>发送</button>
    </div>
    {preview && <PreviewModal groupId={group.id} date={preview.date} batch={preview} onClose={() => setPreview(null)} onChanged={async () => { setPreview(null); await reloadPlan(); await onChanged(); }} />}
  </Modal>;
}

function AccountSelect({ send, value, onChange }: { send: SendSettings; value: string; onChange: (value: string) => void }) {
  const fallback = resolveAccount(send.pool, undefined);
  return <select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">默认（{fallback?.name ?? '无可用账号'}）</option>
    {send.pool.accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.enabled ? '' : '（已停用）'}{account.kind === 'remote' ? ` · ${account.host}` : ' · 本机'}</option>)}
  </select>;
}
