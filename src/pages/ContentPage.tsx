import React, { useState } from 'react';
import { call, formatTime } from '../api';
import { CONTENT_CHANNELS, CONTENT_SOURCE_LABELS, CONTENT_STATUS_LABELS, type ContentChannel, type ContentPiece, type ContentStatus } from '../domain/ops';
import { Card, Empty, Field, Modal, Notice, Pill, Tabs, useAction, useLoad } from '../ui';

const STATUS_TONE: Record<ContentStatus, 'muted' | 'warn' | 'ok' | 'info'> = { draft: 'muted', reviewing: 'warn', approved: 'ok', scheduled: 'info', sent: 'info' };
type Filter = ContentStatus | 'all';

/** 内容中心：AI / 模板生成 + 人工编辑审核，只负责“怎么说”。 */
export function ContentPage({ onSchedule }: { onSchedule: (contentId: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, error, reload] = useLoad(() => call('content.list', {}), []);
  const [open, setOpen] = useState<ContentPiece | null>(null);
  const [creating, setCreating] = useState(false);
  const list = (all ?? []).filter(piece => filter === 'all' || piece.status === filter);
  const count = (status: ContentStatus) => (all ?? []).filter(piece => piece.status === status).length;

  return <>
    <Card title="内容" extra={<button className="primary" onClick={() => setCreating(true)}>新建内容</button>}>
      <Tabs<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部', count: all?.length }, ...(Object.keys(CONTENT_STATUS_LABELS) as ContentStatus[]).map(status => ({ value: status, label: CONTENT_STATUS_LABELS[status], count: count(status) }))]} />
      {error && <p className="notice error">{error}</p>}
      {list.length ? <table className="ops-table clickable">
        <thead><tr><th>标题</th><th>类型</th><th>来源</th><th>关联路线</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>{list.map(piece => <tr key={piece.id} onClick={() => setOpen(piece)}>
          <td><strong>{piece.title}</strong><small>v{piece.version}</small></td><td>{piece.channel}</td><td>{CONTENT_SOURCE_LABELS[piece.source]}</td>
          <td>{piece.routeName ?? '—'}</td><td><Pill tone={STATUS_TONE[piece.status]}>{CONTENT_STATUS_LABELS[piece.status]}</Pill></td><td className="mono">{formatTime(piece.updatedAt)}</td>
        </tr>)}</tbody>
      </table> : all && <Empty>{filter === 'all' ? '还没有内容。在“路线管理”里打开一条路线，点“生成运营内容”；或者点右上角手动新建。' : `没有${CONTENT_STATUS_LABELS[filter as ContentStatus]}的内容。`}</Empty>}
    </Card>
    {open && <ContentDetail piece={open} onClose={() => setOpen(null)} onChanged={async next => { setOpen(next); await reload(); }} onSchedule={onSchedule} />}
    {creating && <Modal title="新建内容" onClose={() => setCreating(false)} wide>
      <ContentForm onSaved={async piece => { setCreating(false); await reload(); setOpen(piece); }} />
    </Modal>}
  </>;
}

function ContentForm({ onSaved }: { onSaved: (piece: ContentPiece) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [channel, setChannel] = useState<ContentChannel>('通知');
  const [body, setBody] = useState('');
  const { busy, notice, run } = useAction();
  return <>
    <div className="form-grid">
      <Field label="标题"><input value={title} placeholder="例如：国庆出团集合通知" onChange={event => setTitle(event.target.value)} autoFocus /></Field>
      <Field label="类型"><select value={channel} onChange={event => setChannel(event.target.value as ContentChannel)}>{CONTENT_CHANNELS.map(value => <option key={value}>{value}</option>)}</select></Field>
    </div>
    <Field label="正文"><textarea className="editor-body" value={body} onChange={event => setBody(event.target.value)} /></Field>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="primary" disabled={busy || !title.trim() || !body.trim()} onClick={() => void run(async () => { await onSaved(await call('content.save', { title, channel, body })); })}>保存草稿</button></div>
  </>;
}

function ContentDetail({ piece, onClose, onChanged, onSchedule }: { piece: ContentPiece; onClose: () => void; onChanged: (next: ContentPiece | null) => Promise<void>; onSchedule: (contentId: string) => void }) {
  const [title, setTitle] = useState(piece.title);
  const [channel, setChannel] = useState(piece.channel);
  const [body, setBody] = useState(piece.body);
  const [showVersions, setShowVersions] = useState(false);
  const [versions] = useLoad(() => call('content.versions', { id: piece.id }), [piece.id, piece.version]);
  const { busy, notice, run } = useAction();
  const locked = piece.status === 'scheduled' || piece.status === 'sent';
  const dirty = title !== piece.title || channel !== piece.channel || body !== piece.body;
  const sync = (next: ContentPiece) => { setTitle(next.title); setChannel(next.channel); setBody(next.body); return onChanged(next); };
  const act = (action: () => Promise<ContentPiece>, message: string) => void run(async () => { await sync(await action()); return message; });
  const saveFirst = async () => (dirty ? call('content.save', { id: piece.id, title, channel, body, routeId: piece.routeId }) : piece);

  return <Modal title={piece.title} onClose={onClose} wide>
    <div className="content-meta">
      <Pill tone={STATUS_TONE[piece.status]}>{CONTENT_STATUS_LABELS[piece.status]}</Pill>
      <span>{CONTENT_SOURCE_LABELS[piece.source]}</span>{piece.routeName && <span>路线：{piece.routeName}</span>}<span>v{piece.version}</span>
      <button className="link" onClick={() => setShowVersions(!showVersions)}>{showVersions ? '收起历史版本' : `历史版本（${versions?.length ?? 0}）`}</button>
    </div>
    {showVersions && <div className="version-list">{versions?.map(version => <details key={version.version}><summary>v{version.version} · {version.note || '修改'} · {formatTime(version.createdAt)}</summary><p className="pre">{version.body}</p>
      {!locked && version.body !== body && <button className="link" onClick={() => setBody(version.body)}>用这个版本替换正文</button>}</details>)}</div>}
    <div className="form-grid">
      <Field label="标题"><input value={title} disabled={locked} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label="类型"><select value={channel} disabled={locked} onChange={event => setChannel(event.target.value as ContentChannel)}>{CONTENT_CHANNELS.map(value => <option key={value}>{value}</option>)}</select></Field>
    </div>
    <Field label="正文" hint={piece.status === 'approved' ? '修改已通过的内容会退回草稿，需要重新审核' : locked ? '已排期或已发送的内容不能修改' : undefined}>
      <textarea className="editor-body" value={body} disabled={locked} onChange={event => setBody(event.target.value)} />
    </Field>
    <Notice notice={notice} />
    <div className="inline-actions spread">
      <div className="inline-actions">
        {!locked && <button className="link danger-text" disabled={busy} onClick={() => { if (window.confirm('确定删除这条内容吗？')) void run(async () => { await call('content.delete', { id: piece.id }); await onChanged(null); }); }}>删除</button>}
        {!locked && piece.routeId && <button className="secondary" disabled={busy} onClick={() => act(() => call('content.regenerate', { id: piece.id }), '已重新生成，旧版本可在历史版本里找回')}>AI 重新生成</button>}
      </div>
      <div className="inline-actions">
        {!locked && <button className="secondary" disabled={busy || !dirty} onClick={() => act(saveFirst, '已保存')}>保存草稿</button>}
        {piece.status === 'draft' && <button className="primary" disabled={busy} onClick={() => act(async () => { await saveFirst(); return call('content.submit', { id: piece.id }); }, '已提交审核')}>提交审核</button>}
        {piece.status === 'reviewing' && <>
          <button className="secondary" disabled={busy} onClick={() => act(async () => { await saveFirst(); return call('content.reject', { id: piece.id }); }, '已退回修改')}>退回修改</button>
          <button className="primary" disabled={busy} onClick={() => act(async () => { const saved = await saveFirst(); return saved.status === 'reviewing' ? call('content.approve', { id: piece.id }) : saved; }, '审核通过')}>审核通过</button>
        </>}
        {(piece.status === 'approved' || piece.status === 'scheduled' || piece.status === 'sent') && !dirty && <button className="primary" onClick={() => onSchedule(piece.id)}>创建运营任务</button>}
      </div>
    </div>
  </Modal>;
}
