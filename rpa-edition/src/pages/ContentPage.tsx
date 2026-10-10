import React, { useEffect, useState } from 'react';
import { call } from '../api';
import { addDays, localDateText, TEMPLATE_META, WEATHER_RULE_KIND_LABELS, type MessageTemplate, type TemplateKey, type WeatherRule, type WeatherRuleKind } from '../domain/ops';
import { PreviewModal } from '../plan-ui';
import { Card, Field, Notice, Tabs, useAction, useLoad } from '../ui';

type Tab = 'templates' | 'weather' | 'preview';

/** 内容中心：只放模板和天气对照表；可以预览某个群某天会收到什么。内容由客户自己录，软件只负责组织和发送。 */
export function ContentPage() {
  const [tab, setTab] = useState<Tab>('templates');
  return <>
    <Tabs<Tab> value={tab} onChange={setTab} options={[{ value: 'templates', label: '消息模板' }, { value: 'weather', label: '天气对照表' }, { value: 'preview', label: '预览' }]} />
    {tab === 'templates' && <Templates />}
    {tab === 'weather' && <WeatherRules />}
    {tab === 'preview' && <Preview />}
  </>;
}

function Templates() {
  const [templates, error, reload] = useLoad(() => call('template.list'), []);
  return <>
    <Card title="消息模板">
      <p className="hint">花括号里的内容由软件填。方括号 [ ] 里的一段，只要有一个值是空的就整段去掉（比如天气没查到时去掉“天气参考…”半句）；一行里的值全是空的，这一行也不发。</p>
      {error && <p className="notice error">{error}</p>}
    </Card>
    {templates?.map(template => <TemplateEditor key={template.key} template={template} onSaved={reload} />)}
  </>;
}

function TemplateEditor({ template, onSaved }: { template: MessageTemplate; onSaved: () => Promise<void> }) {
  const [body, setBody] = useState(template.body);
  const { busy, notice, run } = useAction();
  useEffect(() => setBody(template.body), [template.body]);
  const meta = TEMPLATE_META[template.key as TemplateKey];
  return <Card title={meta.label} extra={<span className="hint">{meta.when}</span>}>
    <textarea className="tall mono-text" value={body} onChange={event => setBody(event.target.value)} />
    <div className="chip-row">{meta.placeholders.map(name => <button key={name} className="chip" title="点一下插到末尾" onClick={() => setBody(`${body}{${name}}`)}>{`{${name}}`}</button>)}</div>
    <Notice notice={notice} />
    <div className="inline-actions end">
      {!template.isDefault && <button className="link" disabled={busy} onClick={() => { if (window.confirm('恢复成默认模板？')) void run(async () => { await call('template.reset', { key: template.key }); await onSaved(); return '已恢复默认'; }); }}>恢复默认</button>}
      <button className="primary" disabled={busy || body === template.body} onClick={() => void run(async () => { await call('template.save', { key: template.key, body }); await onSaved(); return '已保存，之后发的消息按新模板'; })}>保存</button>
    </div>
  </Card>;
}

type DraftRule = Omit<WeatherRule, 'id'> & { id?: string };
const KINDS = Object.keys(WEATHER_RULE_KIND_LABELS) as WeatherRuleKind[];

/** 天气对照表：明天的天气命中哪几行，就把这几行的出行必备、建议着装合起来，去掉重复。 */
function WeatherRules() {
  const [saved, error, reload] = useLoad(() => call('weatherRule.list'), []);
  const [rules, setRules] = useState<DraftRule[] | null>(null);
  const [city, setCity] = useState('昆明');
  const [date, setDate] = useState(addDays(localDateText(new Date()), 1));
  const [result, setResult] = useState<string>('');
  const { busy, notice, run } = useAction();
  useEffect(() => { if (saved) setRules(saved); }, [saved]);
  if (!rules) return <Card title="天气对照表">{error ? <p className="notice error">{error}</p> : <p className="hint">加载中…</p>}</Card>;
  const update = (index: number, patch: Partial<DraftRule>) => setRules(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  return <>
    <Card title="天气对照表" extra={<button className="secondary" onClick={() => setRules([...rules, { kind: 'weather', value: '', essentials: '', clothing: '' }])}>＋ 加一行</button>}>
      <p className="hint">明日提醒里的“出行必备”和“建议着装”按这张表自动生成：明天的天气命中哪几行，就把这几行合起来、去掉重复。天气没查到时只用“每天都带”那几行。天气描述有：晴、晴间多云、多云、阴、雾、小雨、中雨、大雨、雪、雷阵雨，降水概率高时是“多云转阵雨”这样。</p>
      <table className="ops-table compact rule-table">
        <thead><tr><th>条件</th><th></th><th>出行必备</th><th>建议着装</th><th /></tr></thead>
        <tbody>{rules.map((rule, index) => <tr key={rule.id ?? `new-${index}`}>
          <td><select value={rule.kind} onChange={event => update(index, { kind: event.target.value as WeatherRuleKind })}>{KINDS.map(kind => <option key={kind} value={kind}>{WEATHER_RULE_KIND_LABELS[kind]}</option>)}</select></td>
          <td>{rule.kind === 'always' ? <span className="hint">—</span> : <input value={rule.value} placeholder={rule.kind === 'weather' ? '雨' : '10'} onChange={event => update(index, { value: event.target.value })} />}{(rule.kind === 'minBelow' || rule.kind === 'maxAbove') && <small>℃</small>}</td>
          <td><input value={rule.essentials} placeholder="雨具" onChange={event => update(index, { essentials: event.target.value })} /></td>
          <td><input value={rule.clothing} placeholder="防水外套" onChange={event => update(index, { clothing: event.target.value })} /></td>
          <td className="actions-cell">
            <button className="link" disabled={index === 0} onClick={() => { const list = [...rules]; [list[index - 1], list[index]] = [list[index], list[index - 1]]; setRules(list); }}>↑</button>
            <button className="link danger-text" onClick={() => setRules(rules.filter((_, i) => i !== index))}>删除</button>
          </td>
        </tr>)}</tbody>
      </table>
      <Notice notice={notice} />
      <div className="inline-actions end">
        {dirty && <button className="link" onClick={() => setRules(saved)}>撤销修改</button>}
        <button className="primary" disabled={busy || !dirty} onClick={() => void run(async () => { setRules(await call('weatherRule.save', { rules })); await reload(); return '已保存'; })}>保存</button>
      </div>
    </Card>
    <Card title="试一下">
      <div className="inline-actions">
        <input value={city} onChange={event => setCity(event.target.value)} placeholder="城市" />
        <input type="date" value={date} onChange={event => setDate(event.target.value)} />
        <button className="secondary" disabled={busy || !city.trim()} onClick={() => void run(async () => {
          const test = await call('weatherRule.test', { city, date });
          setResult([test.weather ? `${test.weather.city}：${test.weather.condition}，${Math.round(test.weather.min)}–${Math.round(test.weather.max)}℃` : `天气没查到：${test.error}`, `出行必备：${test.essentials || '（无）'}`, `建议着装：${test.clothing || '（无）'}`].join('\n'));
        })}>查天气并套用对照表</button>
      </div>
      <p className="hint">用的是已保存的对照表。最多能查未来 16 天。</p>
      {result && <div className="preview-box"><p>{result}</p></div>}
    </Card>
  </>;
}

/** 预览：选一个群和日期，看那天傍晚会收到什么。 */
function Preview() {
  const [groups] = useLoad(() => call('group.list'), []);
  const withTour = (groups ?? []).filter(group => group.tour);
  const [groupId, setGroupId] = useState('');
  const [date, setDate] = useState(localDateText(new Date()));
  const [open, setOpen] = useState(false);
  const selected = groupId || withTour.find(group => group.phase === 'ongoing' || group.phase === 'upcoming')?.id || withTour[0]?.id || '';
  return <Card title="预览某个群会收到什么">
    <p className="hint">按现在的路线、模板和天气对照表实时生成，不会发送。日期是发送那天（傍晚发明天的提醒）。</p>
    <div className="form-grid">
      <Field label="群"><select value={selected} onChange={event => setGroupId(event.target.value)}>{withTour.length ? withTour.map(group => <option key={group.id} value={group.id}>{group.name}（{group.routeName}）</option>) : <option value="">还没有团</option>}</select></Field>
      <Field label="哪天傍晚"><input type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
    </div>
    <div className="inline-actions end"><button className="primary" disabled={!selected || !date} onClick={() => setOpen(true)}>预览</button></div>
    {open && selected && <PreviewModal groupId={selected} date={date} onClose={() => setOpen(false)} />}
  </Card>;
}
