import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './business-ui.css';
import { GroupMessagePanel } from './GroupMessagePanel';
import { DailyPushPanel } from './DailyPushPanel';
import type { NaturalLanguageCommand, WeatherGreeting, WeatherJobSettings } from './domain/business';

type ConnectionState = 'checking' | 'unauthorized' | 'authorizing' | 'authorized' | 'error';
type OperationState = 'idle' | 'sending' | 'success' | 'error';

function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('checking');
  const [operationState, setOperationState] = useState<OperationState>('idle');
  const [detail, setDetail] = useState('准备就绪');
  const [qr, setQr] = useState<string | null>(null);
  const [message, setMessage] = useState('TravelBot V0.1 连接测试成功 ✅');
  const [groups, setGroups] = useState<Array<{ id?: string; name: string; lastTime?: string }>>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [scheduleMessage, setScheduleMessage] = useState('TravelBot 定时通知');
  const [scheduleHint, setScheduleHint] = useState('');
  const [scheduleChannel, setScheduleChannel] = useState<'bot' | 'groupmsg'>('bot');
  const [selectedCustomerChatIds, setSelectedCustomerChatIds] = useState<string[]>([]);
  const [weatherJob, setWeatherJob] = useState<WeatherJobSettings>({ id: 'default', location: '', chatIds: [], intervalMinutes: 60, enabled: false });
  const [weatherHint, setWeatherHint] = useState('');
  const [weatherGreeting, setWeatherGreeting] = useState<WeatherGreeting | null>(null);
  const [assistantText, setAssistantText] = useState('');
  const [assistantHint, setAssistantHint] = useState('');
  const [pendingCommand, setPendingCommand] = useState<NaturalLanguageCommand | null>(null);
  const connected = connectionState === 'authorized';

  const check = async () => {
    const result = await window.travelbot.authStatus();
    if (result.ok && result.stdout?.trim().toLowerCase() === 'authorized') { setConnectionState('authorized'); setDetail('企业微信已授权，可以发送测试消息'); }
    else if (connectionState !== 'authorizing') { setConnectionState(result.ok ? 'unauthorized' : 'error'); setDetail(result.ok ? '尚未授权，请扫码绑定企业微信' : (result.stderr || '授权状态检查失败')); }
  };
  useEffect(() => { void check(); }, []);
  useEffect(() => { void window.travelbot.getSettings().then(settings => { setScheduleEnabled(settings.enabled); setIntervalMinutes(settings.intervalMinutes); setScheduleMessage(settings.message); setSelectedGroupIds(settings.chatIds || []); setScheduleChannel(settings.channel || 'bot'); setSelectedCustomerChatIds(settings.customerChatIds || []); }); }, []);
  useEffect(() => { void window.travelbot.getWeatherJob().then(setWeatherJob); }, []);
  const loadGroups = async () => { setGroupsLoading(true); try { const result = await window.travelbot.listGroups(); setGroups(result.groups); setSelectedGroupIds(current => { const valid = current.filter(id => result.groups.some(group => group.id === id)); return valid.length ? valid : (result.groups[0]?.id ? [result.groups[0].id] : []); }); if (!result.ok) setDetail(result.stderr || '群聊列表加载失败'); } finally { setGroupsLoading(false); } };
  useEffect(() => { if (connected) void loadGroups(); }, [connected]);
  useEffect(() => {
    if (connectionState !== 'authorizing') return;
    const timer = window.setInterval(() => { void check(); }, 2500);
    return () => window.clearInterval(timer);
  }, [connectionState]);

  const authorize = async () => {
    setConnectionState('authorizing'); setDetail('正在生成二维码，扫码后请在企业微信中确认（最多等待 5 分钟）'); setQr(null);
    const result = await window.travelbot.startAuth();
    if (result.qrcode) setQr(result.qrcode);
    if (result.ok && result.pending) { setConnectionState('authorizing'); setDetail('二维码已生成，请立即使用企业微信扫码并确认'); }
    else if (result.ok) { setConnectionState('authorized'); setDetail('连接成功！企业微信授权已保存到本机'); }
    else { setConnectionState('error'); setDetail(result.stderr || '授权未完成'); }
  };
  const send = async () => {
    setOperationState('sending'); setDetail('正在通过 wecom-cli 发送消息…');
    if (!selectedGroupIds.length) { setOperationState('error'); setDetail('请先选择至少一个可发送的群聊'); return; }
    const result = await window.travelbot.sendTest(message, selectedGroupIds);
    if (result.ok) { setOperationState('success'); setDetail('测试消息已发送，请在企业微信中查看'); }
    else { setOperationState('error'); setDetail(result.stderr || '消息发送失败'); }
  };
  const busy = connectionState === 'authorizing' || operationState === 'sending';
  const selectedGroupNames = groups.filter(group => selectedGroupIds.includes(group.id || '')).map(group => group.name);
  const saveSchedule = async () => {
    setScheduleHint('正在保存后台任务…');
    const viaGroupMessage = scheduleChannel === 'groupmsg';
    const result = await window.travelbot.saveSchedule({ enabled: scheduleEnabled, channel: scheduleChannel, groupIds: selectedGroupIds, groupNames: selectedGroupNames, customerChatIds: selectedCustomerChatIds, intervalMinutes, message: scheduleMessage });
    const target = viaGroupMessage ? `为 ${selectedCustomerChatIds.length} 个客户群创建群发任务` : `发送到 ${selectedGroupNames.length} 个群聊`;
    setScheduleHint(result.ok ? (scheduleEnabled ? `已启用：每 ${intervalMinutes} 分钟${target}` : '后台定时发送已关闭') : (result.stderr || '保存失败'));
  };
  const scheduleReady = scheduleChannel === 'groupmsg' ? selectedCustomerChatIds.length > 0 : connected && selectedGroupIds.length > 0;
  const previewWeather = async () => { setWeatherHint('正在获取实时天气…'); const result = await window.travelbot.weatherPreview(weatherJob.location); if (result.ok && result.greeting) { setWeatherGreeting(result.greeting); setWeatherHint('天气获取成功'); } else setWeatherHint(result.stderr || '天气获取失败'); };
  const saveWeather = async () => { setWeatherHint('正在保存天气任务…'); const result = await window.travelbot.saveWeatherJob({ location: weatherJob.location, chatIds: selectedGroupIds, intervalMinutes: weatherJob.intervalMinutes, enabled: weatherJob.enabled }); if (result.ok && result.job) { setWeatherJob(result.job); setWeatherHint(weatherJob.enabled ? `已启用天气问候，每 ${weatherJob.intervalMinutes} 分钟发送到 ${selectedGroupNames.length} 个群聊` : '天气问候任务已关闭'); } else setWeatherHint(result.stderr || '保存失败'); };
  const runWeather = async () => { setWeatherHint('正在发送天气问候…'); const result = await window.travelbot.runWeatherJob(); setWeatherHint(result.ok ? '天气问候已发送' : (result.stderr || '天气问候发送失败')); if (result.greeting) setWeatherGreeting(result.greeting); };
  const runAssistant = async () => { setAssistantHint('正在理解你的请求…'); const result = await window.travelbot.contentCommand(assistantText); if (!result.ok) { setAssistantHint(result.stderr || '处理失败'); return; } if (result.command?.intent === 'search') { setPendingCommand(null); setAssistantHint(`查询完成：找到 ${result.items?.length ?? 0} 条内容`); return; } if (result.command?.intent === 'unknown') { setAssistantHint(result.command.reason); return; } setPendingCommand(result.command ?? null); setAssistantHint('这是一个会修改本地数据的操作，请确认后执行'); };
  const confirmAssistant = async (confirmed: boolean) => { if (!pendingCommand) return; const result = await window.travelbot.contentConfirm({ command: pendingCommand, confirmed }); setAssistantHint(result.ok ? '操作已完成' : (result.stderr || '操作未完成')); setPendingCommand(null); };
  return <main className="shell">
    <header><div className="logo">TB</div><div><div className="eyebrow">TRAVELBOT DESKTOP</div><h1>企业微信连接中心</h1></div><span className="version">V0.1 PoC</span></header>
    <section className="hero"><div><div className="eyebrow accent">ONE-CLICK CONNECTION</div><h2>把 TravelBot 接入你的企业微信</h2><p>安装后扫码授权，完成连接，再发送一条真实测试消息。</p></div><div className={`status-dot ${connected ? 'authorized' : connectionState}`}><i />{connected ? '已连接' : connectionState === 'error' ? '需要处理' : '未连接'}</div></section>
    <section className="steps"><Step n="01" title="安装 EXE" done /><Step n="02" title="扫码授权" active={connectionState === 'authorizing'} done={connectionState === 'authorized'} /><Step n="03" title="发送测试消息" active={operationState === 'sending'} done={operationState === 'success'} /></section>
    <section className="card"><div className="card-title"><span>连接状态</span><button className="refresh-button" onClick={() => void check()} disabled={busy} title="刷新连接状态" aria-label="刷新连接状态"><span>↻</span></button></div><div className="connection"><div className={`icon ${connected ? 'authorized' : connectionState}`}><span>{connected ? '✓' : '↗'}</span></div><div><strong>{connected ? '企业微信已连接' : '等待企业微信授权'}</strong><p>{detail}</p></div></div>{qr && <div className="qr-box"><img src={`file://${qr}`} alt="企业微信授权二维码" /><button className="link" onClick={() => void window.travelbot.openImage(qr)}>在系统中打开二维码</button></div>}<div className="actions"><button className="primary" onClick={() => void authorize()} disabled={busy}>{connected ? '重新扫码授权' : '扫码授权'}</button></div></section>
    <section className="card test-card"><div className="card-title"><span>发送测试消息</span><button className="refresh-button" onClick={() => void loadGroups()} disabled={busy || groupsLoading} title="刷新群聊列表" aria-label="刷新群聊列表"><span className={groupsLoading ? 'spinning' : ''}>↻</span></button></div><label>目标群聊（可多选）</label>{groups.length ? <div className="group-list">{groups.map(group => <button className={`group-card ${selectedGroupIds.includes(group.id || '') ? 'selected' : ''}`} key={group.id ?? `${group.name}-${group.lastTime ?? ''}`} onClick={() => { const id = group.id || ''; setSelectedGroupIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }} disabled={busy}><span className="group-avatar">群</span><span className="group-meta"><strong>{group.name}</strong><small>{group.lastTime ? `最近会话 ${group.lastTime}` : '可发送会话'}</small></span><span className="group-check">{selectedGroupIds.includes(group.id || '') ? '✓' : ''}</span></button>)}</div> : <p className="hint">暂未找到可发送群聊。请先把机器人加入群聊，并在群里给机器人发一条消息。</p>}<label>消息内容</label><textarea value={message} onChange={e => setMessage(e.target.value)} disabled={busy} /><button className="primary" onClick={() => void send()} disabled={busy || !connected || !selectedGroupIds.length}>{operationState === 'sending' ? '发送中…' : '发送测试消息'}</button>{!connected && <p className="hint">请先完成企业微信扫码授权</p>}</section>
    <GroupMessagePanel selectedChatIds={selectedCustomerChatIds} onSelectedChatIdsChange={setSelectedCustomerChatIds} scheduleMessage={scheduleMessage} />
    <DailyPushPanel />
    <section className="card schedule-card"><div className="card-title"><span>后台定时发送</span><span className="tiny">关闭窗口后继续运行</span></div><label className="toggle-row"><input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />启用后台定时发送</label><div className="channel-row"><label className="toggle-row"><input type="radio" name="schedule-channel" checked={scheduleChannel === 'bot'} onChange={() => setScheduleChannel('bot')} />机器人直接发送（上方测试群聊）</label><label className="toggle-row"><input type="radio" name="schedule-channel" checked={scheduleChannel === 'groupmsg'} onChange={() => setScheduleChannel('groupmsg')} />群发助手（客户群，需发送人确认）</label></div><div className="schedule-grid"><div><label>发送间隔（分钟）</label><input type="number" min="1" value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} /></div><div><label>后台消息模板</label><input value={scheduleMessage} onChange={e => setScheduleMessage(e.target.value)} /></div></div><button className="primary" onClick={() => void saveSchedule()} disabled={busy || !scheduleReady}>保存后台任务</button>{scheduleHint && <p className="hint">{scheduleHint}</p>}</section>
    <section className="card schedule-card"><div className="card-title"><span>天气问候</span><span className="tiny">业务模块</span></div><div className="schedule-grid"><div><label>天气位置</label><input value={weatherJob.location} placeholder="例如：上海" onChange={e => setWeatherJob({ ...weatherJob, location: e.target.value })} /></div><div><label>发送间隔（分钟）</label><input type="number" min="1" value={weatherJob.intervalMinutes} onChange={e => setWeatherJob({ ...weatherJob, intervalMinutes: Number(e.target.value) })} /></div></div><label className="toggle-row"><input type="checkbox" checked={weatherJob.enabled} onChange={e => setWeatherJob({ ...weatherJob, enabled: e.target.checked })} />启用天气问候自动发送</label><div className="inline-actions"><button className="secondary" onClick={() => void previewWeather()} disabled={!weatherJob.location}>预览天气</button><button className="secondary" onClick={() => void runWeather()} disabled={!connected || !selectedGroupIds.length}>立即发送</button><button className="primary" onClick={() => void saveWeather()} disabled={!connected || !selectedGroupIds.length}>保存天气任务</button></div>{weatherGreeting && <div className="preview-box"><strong>{weatherGreeting.title}</strong><p>{weatherGreeting.message}</p></div>}{weatherHint && <p className="hint">{weatherHint}</p>}</section>
    <section className="card schedule-card"><div className="card-title"><span>旅行资料助手</span><span className="tiny">SQLite + 自然语言</span></div><p className="hint">可以输入“查询上海”“新增一条迪士尼攻略”“删除迪士尼攻略”等命令。修改本地资料前需要确认。</p><div className="assistant-row"><input value={assistantText} placeholder="输入资料查询或管理指令" onChange={e => setAssistantText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runAssistant(); }} /><button className="primary" onClick={() => void runAssistant()} disabled={!assistantText.trim()}>执行</button></div>{pendingCommand && <div className="confirm-box"><strong>确认执行：{pendingCommand.intent}</strong><p>{'title' in pendingCommand ? `${pendingCommand.title}：${pendingCommand.body}` : 'query' in pendingCommand ? pendingCommand.query : pendingCommand.reason}</p><div className="inline-actions"><button className="secondary" onClick={() => void confirmAssistant(false)}>取消</button><button className="primary" onClick={() => void confirmAssistant(true)}>确认执行</button></div></div>}{assistantHint && <p className="hint">{assistantHint}</p>}</section>
    <footer>凭证保存在当前 Windows 用户的应用数据目录 · 不会写入项目目录</footer>
  </main>;
}
function Step({ n, title, active, done }: { n: string; title: string; active?: boolean; done?: boolean }) { return <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : n}</span><b>{title}</b></div>; }
createRoot(document.getElementById('root')!).render(<App />);
