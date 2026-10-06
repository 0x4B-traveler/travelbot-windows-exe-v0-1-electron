import React, { useEffect, useState } from 'react';
import type { MessageTemplate, MessageTemplateInput } from './domain/business';

const CATEGORIES = ['出团通知', '集合提醒', '行程提醒', '天气提醒', '安全须知', '返程回访', '营销推广', '其他'];
const EMPTY: MessageTemplateInput = { name: '', category: '出团通知', body: '' };
const STARTERS: MessageTemplateInput[] = [
  { name: '出团前一天通知', category: '出团通知', body: '各位贵宾晚上好！明天就要出发啦～\n集合时间：{时间}\n集合地点：{地点}\n请带好身份证、手机充电器和常用药品，祝大家旅途愉快！' },
  { name: '集合提醒', category: '集合提醒', body: '温馨提醒：请大家于 {时间} 前到达 {地点} 集合，过时不候哦～如有特殊情况请提前联系导游。' },
  { name: '返程回访', category: '返程回访', body: '感谢各位一路相伴！本次旅程已圆满结束，欢迎在群里分享照片和感受，您的建议是我们进步的动力～' },
];

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [category, setCategory] = useState('全部');
  const [draft, setDraft] = useState<MessageTemplateInput | null>(null);
  const [hint, setHint] = useState('');

  const load = async () => setTemplates(await window.travelbot.listTemplates());
  useEffect(() => { void load(); }, []);

  const categories = ['全部', ...Array.from(new Set([...CATEGORIES, ...templates.map(item => item.category).filter(Boolean)]))];
  const visible = category === '全部' ? templates : templates.filter(item => item.category === category);
  const save = async () => {
    if (!draft) return;
    const result = await window.travelbot.saveTemplate(draft);
    if (!result.ok) { setHint(result.stderr || '保存失败'); return; }
    setHint(draft.id ? '模板已更新' : '模板已添加'); setDraft(null); await load();
  };
  const remove = async (item: MessageTemplate) => {
    if (!window.confirm(`确定删除模板「${item.name}」吗？`)) return;
    const result = await window.travelbot.deleteTemplate(item.id);
    setHint(result.ok ? '模板已删除' : (result.stderr || '删除失败'));
    if (draft?.id === item.id) setDraft(null);
    await load();
  };
  const copy = async (item: MessageTemplate) => { await navigator.clipboard.writeText(item.body); setHint(`已复制「${item.name}」`); };
  const addStarters = async () => { for (const starter of STARTERS) await window.travelbot.saveTemplate(starter); setHint('已添加 3 个示例模板'); await load(); };

  return <section className="card schedule-card">
    <div className="card-title"><span>消息模板</span><button className="primary" onClick={() => setDraft({ ...EMPTY, category: category === '全部' ? EMPTY.category : category })}>＋ 新建模板</button></div>
    <p className="hint">模板可以在「客户群群发」中一键填入。花括号内容（如 {'{时间}'}、{'{地点}'}）是提示你发送前替换的占位符。</p>
    <div className="chip-row">{categories.map(value => <button key={value} className={`chip ${category === value ? 'active' : ''}`} onClick={() => setCategory(value)}>{value}</button>)}</div>
    {hint && <p className="hint">{hint}</p>}
    {draft && <div className="editor-box">
      <strong>{draft.id ? '编辑模板' : '新建模板'}</strong>
      <div className="schedule-grid">
        <div><label>分类</label><input list="template-categories" value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /><datalist id="template-categories">{CATEGORIES.map(value => <option key={value} value={value} />)}</datalist></div>
        <div><label>模板名称</label><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：出团前一天通知" /></div>
      </div>
      <label>模板内容</label>
      <textarea className="tall" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} placeholder="消息正文，可使用 {时间} {地点} 等占位符" />
      <div className="inline-actions end"><button className="secondary" onClick={() => setDraft(null)}>取消</button><button className="primary" onClick={() => void save()} disabled={!draft.name.trim() || !draft.body.trim()}>保存</button></div>
    </div>}
    {visible.length ? <div className="item-list">{visible.map(item => <div className="item-card" key={item.id}>
      <div className="item-head"><span className="kind-badge">{item.category || '未分类'}</span><strong>{item.name}</strong></div>
      <p className="item-body">{item.body}</p>
      <div className="item-foot">
        <span className="tiny">更新于 {new Date(item.updatedAt).toLocaleString()}</span>
        <span className="row-actions"><button className="link" onClick={() => void copy(item)}>复制</button><button className="link" onClick={() => setDraft({ id: item.id, name: item.name, category: item.category, body: item.body })}>编辑</button><button className="link danger-text" onClick={() => void remove(item)}>删除</button></span>
      </div>
    </div>)}</div> : <div className="empty-box"><p className="hint">{templates.length ? '该分类下还没有模板' : '还没有消息模板'}</p>{!templates.length && <button className="secondary" onClick={() => void addStarters()}>添加示例模板</button>}</div>}
  </section>;
}
