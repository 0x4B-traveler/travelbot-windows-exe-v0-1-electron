import React, { useEffect, useState } from 'react';
import type { ContentItem, CustomerGroup, GroupMessageConfigView, GroupMessageRecord, GroupMessageResult } from './domain/business';

type Props = {
  selectedChatIds: string[];
  onSelectedChatIdsChange: (ids: string[]) => void;
  scheduleMessage: string;
};

const taskStatusText: Record<number, string> = { 0: '待发送人确认', 2: '发送人已确认发送' };
const sendStatusText: Record<number, string> = { 0: '未发送', 1: '已发送', 2: '发送失败', 3: '发送失败' };

export function GroupMessagePanel({ selectedChatIds, onSelectedChatIdsChange, scheduleMessage }: Props) {
  const [config, setConfig] = useState<GroupMessageConfigView | null>(null);
  const [corpId, setCorpId] = useState('');
  const [senderUserId, setSenderUserId] = useState('');
  const [secret, setSecret] = useState('');
  const [configHint, setConfigHint] = useState('');
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [presets, setPresets] = useState<ContentItem[]>([]);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState('');
  const [history, setHistory] = useState<GroupMessageRecord[]>([]);
  const [results, setResults] = useState<Record<string, GroupMessageResult | string>>({});
  const configured = Boolean(config?.corpId && config.hasSecret && config.senderUserId);
  const groupName = (chatId: string) => groups.find(group => group.chatId === chatId)?.name ?? chatId;

  useEffect(() => {
    void window.travelbot.groupMessageConfig().then(view => { setConfig(view); setCorpId(view.corpId); setSenderUserId(view.senderUserId); });
    void window.travelbot.groupMessageHistory().then(setHistory);
    void window.travelbot.contentSearch({ query: '' }).then(result => setPresets(result.items ?? []));
  }, []);
  useEffect(() => { if (configured) void loadGroups(); }, [configured]);

  const saveConfig = async () => {
    setConfigHint('正在保存配置…');
    const result = await window.travelbot.saveGroupMessageConfig({ corpId, senderUserId, secret });
    if (result.ok && result.config) { setConfig(result.config); setSecret(''); setConfigHint('配置已保存，Secret 已加密存储在本机'); }
    else setConfigHint(result.stderr || '保存失败');
  };
  const loadGroups = async () => {
    setGroupsLoading(true);
    try {
      const result = await window.travelbot.listCustomerGroups();
      setGroups(result.groups);
      if (result.ok) onSelectedChatIdsChange(selectedChatIds.filter(id => result.groups.some(group => group.chatId === id)));
      setHint(result.ok ? (result.groups.length ? '' : '发送人名下没有客户群') : (result.stderr || '客户群列表加载失败'));
    } finally { setGroupsLoading(false); }
  };
  const toggleGroup = (chatId: string) => onSelectedChatIdsChange(selectedChatIds.includes(chatId) ? selectedChatIds.filter(id => id !== chatId) : [...selectedChatIds, chatId]);
  const applyPreset = (value: string) => {
    if (value === '__schedule') setContent(scheduleMessage);
    else { const item = presets.find(preset => preset.id === value); if (item) setContent(`${item.title}\n${item.body}`.trim()); }
  };
  const send = async () => {
    setSending(true); setHint('正在创建群发任务…');
    try {
      const result = await window.travelbot.sendGroupMessage({ chatIds: selectedChatIds, content });
      if (result.ok && result.record) {
        setHistory(current => [result.record!, ...current]);
        const failed = result.failList?.length ? `，${result.failList.length} 个客户群无法发送` : '';
        setHint(`群发任务已创建${failed}。请发送人在企业微信“客户群群发”通知中确认发送。`);
      } else setHint(result.stderr || '创建群发任务失败');
    } finally { setSending(false); }
  };
  const queryResult = async (msgid: string) => {
    setResults(current => ({ ...current, [msgid]: '查询中…' }));
    const result = await window.travelbot.groupMessageResult(msgid);
    setResults(current => ({ ...current, [msgid]: result.ok && result.result ? result.result : (result.stderr || '查询失败') }));
  };

  return <section className="card schedule-card test-card groupmsg-card">
    <div className="card-title"><span>客户群群发（群发助手）</span><span className="tiny">企业微信服务端接口</span></div>
    <p className="hint">通过“客户群群发”接口创建任务，发送人在企业微信中确认后才会发出。运行本程序的电脑公网 IP 需加入应用的“企业可信 IP”。</p>
    <div className="schedule-grid">
      <div><label>企业 ID（corpid）</label><input value={corpId} onChange={e => setCorpId(e.target.value)} /></div>
      <div><label>发送人 userid（群主）</label><input value={senderUserId} onChange={e => setSenderUserId(e.target.value)} /></div>
    </div>
    <label>客户联系 Secret</label>
    <input type="password" value={secret} placeholder={config?.hasSecret ? '已保存，留空则不修改' : '在管理后台“客户联系”中获取'} onChange={e => setSecret(e.target.value)} autoComplete="off" />
    <div className="inline-actions"><button className="secondary" onClick={() => void saveConfig()} disabled={!corpId.trim() || !senderUserId.trim() || (!secret.trim() && !config?.hasSecret)}>保存配置</button></div>
    {config && !config.encryptionAvailable && <p className="hint">当前系统不支持加密存储，无法保存 Secret。</p>}
    {configHint && <p className="hint">{configHint}</p>}

    <div className="card-title"><span>目标客户群（可多选）</span><button className="refresh-button" onClick={() => void loadGroups()} disabled={!configured || groupsLoading} title="刷新客户群列表" aria-label="刷新客户群列表"><span className={groupsLoading ? 'spinning' : ''}>↻</span></button></div>
    {groups.length ? <div className="group-list">{groups.map(group => <button className={`group-card ${selectedChatIds.includes(group.chatId) ? 'selected' : ''}`} key={group.chatId} onClick={() => toggleGroup(group.chatId)} disabled={sending}><span className="group-avatar">客</span><span className="group-meta"><strong>{group.name}</strong><small>{group.memberCount} 人</small></span><span className="group-check">{selectedChatIds.includes(group.chatId) ? '✓' : ''}</span></button>)}</div> : <p className="hint">{configured ? '暂无客户群，点击右上角刷新' : '保存配置后加载发送人名下的客户群'}</p>}

    <label>预设内容</label>
    <select defaultValue="" onChange={e => { applyPreset(e.target.value); e.target.value = ''; }}>
      <option value="" disabled>选择预设内容填入…</option>
      <option value="__schedule">后台定时消息模板</option>
      {presets.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <label>群发内容</label>
    <textarea value={content} onChange={e => setContent(e.target.value)} disabled={sending} />
    <button className="primary" onClick={() => void send()} disabled={!configured || sending || !selectedChatIds.length || !content.trim()}>{sending ? '创建中…' : `创建群发任务（${selectedChatIds.length} 个客户群）`}</button>
    {hint && <p className="hint">{hint}</p>}

    {history.length > 0 && <>
      <label>最近群发记录</label>
      {history.slice(0, 10).map(record => {
        const result = results[record.msgid];
        return <div className="preview-box" key={record.msgid}>
          <strong>{new Date(record.createdAt).toLocaleString()} · {record.source === 'schedule' ? '定时' : '手动'} · {record.chatIds.length} 个客户群</strong>
          <p>{record.content.length > 60 ? `${record.content.slice(0, 60)}…` : record.content}</p>
          <div className="inline-actions"><button className="secondary" onClick={() => void queryResult(record.msgid)}>查询发送结果</button></div>
          {typeof result === 'string' && <p className="hint">{result}</p>}
          {result && typeof result !== 'string' && <p className="hint">
            {result.tasks.map(task => `${task.userid}：${taskStatusText[task.status] ?? `状态 ${task.status}`}`).join('；') || '暂无任务信息'}
            {result.sends.length > 0 && <><br />{result.sends.map(item => `${groupName(item.chatId)}：${sendStatusText[item.status] ?? `状态 ${item.status}`}`).join('；')}</>}
          </p>}
        </div>;
      })}
    </>}
  </section>;
}
