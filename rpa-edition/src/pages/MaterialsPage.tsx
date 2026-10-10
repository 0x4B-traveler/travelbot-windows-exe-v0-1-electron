import React, { useEffect, useState } from 'react';
import { call, formatTime } from '../api';
import { MATERIAL_KIND_LABELS, MATERIAL_SOURCE_LABELS, type Material, type MaterialInput, type MaterialKind, type MaterialQuery } from '../domain/ops';
import { Card, Empty, Field, Modal, Notice, splitTags, Tabs, useAction, useLoad } from '../ui';
import { RoutesPanel } from './RoutesPage';

const KINDS = Object.keys(MATERIAL_KIND_LABELS) as MaterialKind[];
const IMPORT_SAMPLE = '名称\t类型\t城市\t标签\t简介\n石林风景区\t景点\t昆明\t世界遗产\t喀斯特地貌奇观，步行约 3 小时，穿舒适的鞋\n昆明翠湖片区酒店\t酒店\t昆明\t\t步行 5 分钟到翠湖公园，楼下有过桥米线';
type Tab = 'routes' | 'materials';

/** 素材库：路线是核心（固定的几天行程），酒店和景点攻略是路线里引用的素材。 */
export function MaterialsPage() {
  const [tab, setTab] = useState<Tab>('routes');
  return <>
    <Tabs<Tab> value={tab} onChange={setTab} options={[{ value: 'routes', label: '路线' }, { value: 'materials', label: '酒店和景点' }]} />
    {tab === 'routes' ? <RoutesPanel /> : <MaterialsPanel />}
  </>;
}

/** 酒店（发“酒店及周边TIPS”用的介绍）、景点（发“游玩攻略”用的一句话和攻略图）等素材。 */
function MaterialsPanel() {
  const [query, setQuery] = useState<MaterialQuery>({});
  const [text, setText] = useState('');
  const [items, error, reload] = useLoad(() => call('material.list', query), [query]);
  const [facets, , reloadFacets] = useLoad(() => call('material.facets'), []);
  const [detail, setDetail] = useState<Material | null>(null);
  const [editing, setEditing] = useState<MaterialInput | null>(null);
  const [importing, setImporting] = useState(false);
  const { notice, run } = useAction();
  const refresh = async () => { await reload(); await reloadFacets(); };

  return <>
    <Card title={`素材（${items?.length ?? 0}）`} extra={<div className="inline-actions"><button className="secondary" onClick={() => run(async () => {
        if (!window.confirm('导入云南示例数据？会新增约 40 条素材（景点攻略带图、酒店）和一条“云南昆明大理丽江6日游”路线，已存在的会跳过。')) return '';
        const testTour = window.confirm('要不要再建一个测试团？\n\n群是你自己的“文件传输助手”，明天出发，今天傍晚开始每天会把这个团的消息发到文件传输助手，不会发到任何客户群。\n\n点“确定”建测试团，点“取消”只导入数据。');
        const result = await call('sample.load', { name: 'yunnan', testTour });
        await refresh();
        return `已导入${result.name}：素材 ${result.materials} 条、图片 ${result.images} 张、路线 ${result.routes} 条${result.skipped ? `，跳过已存在 ${result.skipped} 项` : ''}。${result.tour ? `测试团“${result.tour.groupName}”${result.tour.startDate}出发，可以在群管理里看。` : ''}`;
      })}>导入云南示例数据</button><button className="secondary" onClick={() => setImporting(true)}>导入</button><button className="primary" onClick={() => setEditing({ kind: 'spot', title: '', body: '', city: '', tags: [] })}>新增素材</button></div>}>
      <div className="filter-row">
        <input value={text} placeholder="搜索名称、简介、标签" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setQuery({ ...query, text }); }} />
        <select value={query.kind ?? ''} onChange={event => setQuery({ ...query, kind: (event.target.value || undefined) as MaterialKind | undefined })}><option value="">全部类型</option>{KINDS.map(kind => <option key={kind} value={kind}>{MATERIAL_KIND_LABELS[kind]}</option>)}</select>
        <select value={query.city ?? ''} onChange={event => setQuery({ ...query, city: event.target.value || undefined })}><option value="">全部城市</option>{facets?.cities.map(city => <option key={city}>{city}</option>)}</select>
        <select value={query.tag ?? ''} onChange={event => setQuery({ ...query, tag: event.target.value || undefined })}><option value="">全部标签</option>{facets?.tags.map(tag => <option key={tag}>{tag}</option>)}</select>
        <button className="secondary" onClick={() => setQuery({ ...query, text })}>搜索</button>
      </div>
      <Notice notice={notice} />
      {error && <p className="notice error">{error}</p>}
      {items?.length ? <table className="ops-table clickable">
        <thead><tr><th>名称</th><th>类型</th><th>城市</th><th>标签</th><th>来源</th><th>更新时间</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.id} onClick={() => setDetail(item)}>
          <td><strong>{item.title}</strong>{item.images.length > 0 && <small>🖼 {item.images.length} 张图片</small>}</td>
          <td>{MATERIAL_KIND_LABELS[item.kind]}</td><td>{item.city || '—'}</td><td>{item.tags.join(' / ') || '—'}</td>
          <td>{MATERIAL_SOURCE_LABELS[item.source]}</td><td className="mono">{formatTime(item.updatedAt)}</td>
        </tr>)}</tbody>
      </table> : items && <Empty>{Object.values(query).some(Boolean) ? '没有符合条件的素材。' : '还没有酒店和景点。点右上角“新增素材”，或从 Excel 导入；景点要上传攻略图，酒店写好周边TIPS。'}</Empty>}
    </Card>

    {detail && <MaterialDetail material={detail} onClose={() => setDetail(null)} onEdit={() => { setEditing({ id: detail.id, kind: detail.kind, title: detail.title, body: detail.body, city: detail.city, tags: detail.tags }); setDetail(null); }}
      onChanged={async next => { if (next) setDetail(next); else setDetail(null); await refresh(); }} />}
    {editing && <MaterialEditor input={editing} onClose={() => setEditing(null)} onSaved={async saved => { setEditing(null); await refresh(); setDetail(saved); }} />}
    {importing && <Modal title="从 Excel 导入素材" onClose={() => setImporting(false)} wide><ImportForm onDone={async message => { setImporting(false); await run(async () => message); await refresh(); }} /></Modal>}
  </>;
}

function MaterialDetail({ material, onClose, onEdit, onChanged }: { material: Material; onClose: () => void; onEdit: () => void; onChanged: (next: Material | null) => Promise<void> }) {
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [viewing, setViewing] = useState<number | null>(null);
  const { busy, notice, run } = useAction();
  const shown = material.images.filter(image => images[image.id]);
  useEffect(() => {
    if (viewing === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setViewing(null); }
      if (event.key === 'ArrowRight') setViewing(index => index === null ? null : (index + 1) % shown.length);
      if (event.key === 'ArrowLeft') setViewing(index => index === null ? null : (index - 1 + shown.length) % shown.length);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewing, shown.length]);
  useEffect(() => {
    let alive = true;
    void Promise.all(material.images.map(async image => [image.id, await call('material.imageData', { imageId: image.id }).catch(() => null)] as const))
      .then(entries => { if (alive) setImages(Object.fromEntries(entries)); });
    return () => { alive = false; };
  }, [material]);
  return <Modal title="素材详情" onClose={onClose} wide>
    <dl className="detail-grid">
      <dt>名称</dt><dd><strong>{material.title}</strong></dd>
      <dt>类型</dt><dd>{MATERIAL_KIND_LABELS[material.kind]}</dd>
      <dt>城市</dt><dd>{material.city || '—'}</dd>
      <dt>标签</dt><dd>{material.tags.join(' / ') || '—'}</dd>
      <dt>来源</dt><dd>{MATERIAL_SOURCE_LABELS[material.source]}</dd>
      <dt>简介</dt><dd className="pre">{material.body || '—'}</dd>
      <dt>关联图片</dt><dd>
        <div className="image-row">
          {material.images.map(image => <div className="thumb" key={image.id}>
            {images[image.id] ? <img src={images[image.id]!} alt={image.fileName} title="点击查看大图" onClick={() => setViewing(shown.indexOf(image))} /> : <span>{image.fileName}</span>}
            <button className="link danger-text" disabled={busy} onClick={() => void run(async () => { await onChanged(await call('material.removeImage', { id: material.id, imageId: image.id })); })}>移除</button>
          </div>)}
          <button className="thumb add" disabled={busy} onClick={() => void run(async () => { await onChanged(await call('material.addImages', { id: material.id })); })}>＋ 添加图片</button>
        </div>
      </dd>
    </dl>
    <Notice notice={notice} />
    <div className="inline-actions end">
      <button className="secondary danger" disabled={busy} onClick={() => { if (window.confirm(`确定删除素材“${material.title}”吗？关联的路线节点会保留文字。`)) void run(async () => { await call('material.delete', { id: material.id }); await onChanged(null); }); }}>删除</button>
      <button className="primary" onClick={onEdit}>编辑</button>
    </div>
    {viewing !== null && shown[viewing] && <div className="image-viewer" onClick={() => setViewing(null)}>
      <img src={images[shown[viewing].id]!} alt={shown[viewing].fileName} />
      <small>{shown.length > 1 ? `${viewing + 1} / ${shown.length} · ← → 切换 · ` : ''}点击任意处或按 Esc 关闭</small>
    </div>}
  </Modal>;
}

function MaterialEditor({ input, onClose, onSaved }: { input: MaterialInput; onClose: () => void; onSaved: (saved: Material) => Promise<void> }) {
  const [draft, setDraft] = useState(input);
  const [tags, setTags] = useState(input.tags.join('，'));
  const { busy, notice, run } = useAction();
  return <Modal title={input.id ? '编辑素材' : '新增素材'} onClose={onClose} wide>
    <div className="form-grid">
      <Field label="名称"><input value={draft.title} placeholder="例如：古北水镇" onChange={event => setDraft({ ...draft, title: event.target.value })} autoFocus /></Field>
      <Field label="类型"><select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as MaterialKind })}>{KINDS.map(kind => <option key={kind} value={kind}>{MATERIAL_KIND_LABELS[kind]}</option>)}</select></Field>
      <Field label="城市"><input value={draft.city} placeholder="例如：北京" onChange={event => setDraft({ ...draft, city: event.target.value })} /></Field>
      <Field label="标签" hint="用逗号分隔"><input value={tags} placeholder="亲子，周末，古镇" onChange={event => setTags(event.target.value)} /></Field>
    </div>
    <Field label={draft.kind === 'hotel' ? '酒店介绍和周边TIPS' : draft.kind === 'spot' || draft.kind === 'guide' ? '游玩攻略' : '简介'} hint={draft.kind === 'hotel' ? '发“酒店及周边TIPS”时原样发出' : draft.kind === 'spot' || draft.kind === 'guide' ? '发“游玩攻略”时原样发出，攻略图保存后在详情里添加' : undefined}><textarea className="tall" value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></Field>
    <Notice notice={notice} />
    <div className="inline-actions end"><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy || !draft.title.trim()} onClick={() => void run(async () => { await onSaved(await call('material.save', { ...draft, tags: splitTags(tags) })); })}>保存</button></div>
  </Modal>;
}

function ImportForm({ onDone }: { onDone: (message: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const { busy, notice, run } = useAction();
  return <>
    <p className="hint">在 Excel 里选中表格（含表头）复制，粘贴到下面。表头支持：名称、类型、城市、标签、简介；类型填 {Object.values(MATERIAL_KIND_LABELS).join(' / ')}。</p>
    <textarea className="tall mono-text" value={text} placeholder={IMPORT_SAMPLE} onChange={event => setText(event.target.value)} />
    <Notice notice={notice} />
    <div className="inline-actions end">
      <button className="secondary" onClick={() => setText(IMPORT_SAMPLE)}>填入示例</button>
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void run(async () => {
        const result = await call('material.import', { text });
        if (result.errors.length && !result.added) throw new Error(result.errors.join('\n'));
        await onDone(`已导入 ${result.added} 条素材${result.errors.length ? `，${result.errors.length} 行有问题：${result.errors.join('；')}` : ''}`);
      })}>导入</button>
    </div>
  </>;
}
