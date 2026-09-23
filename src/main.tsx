import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

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
  const connected = connectionState === 'authorized';

  const check = async () => {
    const result = await window.travelbot.authStatus();
    if (result.ok && result.stdout?.trim().toLowerCase() === 'authorized') { setConnectionState('authorized'); setDetail('企业微信已授权，可以发送测试消息'); }
    else if (connectionState !== 'authorizing') { setConnectionState(result.ok ? 'unauthorized' : 'error'); setDetail(result.ok ? '尚未授权，请扫码绑定企业微信' : (result.stderr || '授权状态检查失败')); }
  };
  useEffect(() => { void check(); }, []);
  useEffect(() => { void window.travelbot.getSettings().then(settings => { setScheduleEnabled(settings.enabled); setIntervalMinutes(settings.intervalMinutes); setScheduleMessage(settings.message); setSelectedGroupIds(settings.chatIds || []); }); }, []);
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
  const saveSchedule = async () => { setScheduleHint('正在保存后台任务…'); const result = await window.travelbot.saveSchedule({ enabled: scheduleEnabled, groupIds: selectedGroupIds, groupNames: selectedGroupNames, intervalMinutes, message: scheduleMessage }); setScheduleHint(result.ok ? (scheduleEnabled ? `已启用：每 ${intervalMinutes} 分钟发送到 ${selectedGroupNames.length} 个群聊` : '后台定时发送已关闭') : (result.stderr || '保存失败')); };
  return <main className="shell">
    <header><div className="logo">TB</div><div><div className="eyebrow">TRAVELBOT DESKTOP</div><h1>企业微信连接中心</h1></div><span className="version">V0.1 PoC</span></header>
    <section className="hero"><div><div className="eyebrow accent">ONE-CLICK CONNECTION</div><h2>把 TravelBot 接入你的企业微信</h2><p>安装后扫码授权，完成连接，再发送一条真实测试消息。</p></div><div className={`status-dot ${connected ? 'authorized' : connectionState}`}><i />{connected ? '已连接' : connectionState === 'error' ? '需要处理' : '未连接'}</div></section>
    <section className="steps"><Step n="01" title="安装 EXE" done /><Step n="02" title="扫码授权" active={connectionState === 'authorizing'} done={connectionState === 'authorized'} /><Step n="03" title="发送测试消息" active={operationState === 'sending'} done={operationState === 'success'} /></section>
    <section className="card"><div className="card-title"><span>连接状态</span><button className="refresh-button" onClick={() => void check()} disabled={busy} title="刷新连接状态" aria-label="刷新连接状态"><span>↻</span></button></div><div className="connection"><div className={`icon ${connected ? 'authorized' : connectionState}`}><span>{connected ? '✓' : '↗'}</span></div><div><strong>{connected ? '企业微信已连接' : '等待企业微信授权'}</strong><p>{detail}</p></div></div>{qr && <div className="qr-box"><img src={`file://${qr}`} alt="企业微信授权二维码" /><button className="link" onClick={() => void window.travelbot.openImage(qr)}>在系统中打开二维码</button></div>}<div className="actions"><button className="primary" onClick={() => void authorize()} disabled={busy}>{connected ? '重新扫码授权' : '扫码授权'}</button></div></section>
    <section className="card test-card"><div className="card-title"><span>发送测试消息</span><button className="refresh-button" onClick={() => void loadGroups()} disabled={busy || groupsLoading} title="刷新群聊列表" aria-label="刷新群聊列表"><span className={groupsLoading ? 'spinning' : ''}>↻</span></button></div><label>目标群聊（可多选）</label>{groups.length ? <div className="group-list">{groups.map(group => <button className={`group-card ${selectedGroupIds.includes(group.id || '') ? 'selected' : ''}`} key={group.id ?? `${group.name}-${group.lastTime ?? ''}`} onClick={() => { const id = group.id || ''; setSelectedGroupIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }} disabled={busy}><span className="group-avatar">群</span><span className="group-meta"><strong>{group.name}</strong><small>{group.lastTime ? `最近会话 ${group.lastTime}` : '可发送会话'}</small></span><span className="group-check">{selectedGroupIds.includes(group.id || '') ? '✓' : ''}</span></button>)}</div> : <p className="hint">暂未找到可发送群聊。请先把机器人加入群聊，并在群里给机器人发一条消息。</p>}<label>消息内容</label><textarea value={message} onChange={e => setMessage(e.target.value)} disabled={busy} /><button className="primary" onClick={() => void send()} disabled={busy || !connected || !selectedGroupIds.length}>{operationState === 'sending' ? '发送中…' : '发送测试消息'}</button>{!connected && <p className="hint">请先完成企业微信扫码授权</p>}</section>
    <section className="card schedule-card"><div className="card-title"><span>后台定时发送</span><span className="tiny">关闭窗口后继续运行</span></div><label className="toggle-row"><input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />启用后台定时发送</label><div className="schedule-grid"><div><label>发送间隔（分钟）</label><input type="number" min="1" value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} /></div><div><label>后台消息模板</label><input value={scheduleMessage} onChange={e => setScheduleMessage(e.target.value)} /></div></div><button className="primary" onClick={() => void saveSchedule()} disabled={busy || !connected || !selectedGroupIds.length}>保存后台任务</button>{scheduleHint && <p className="hint">{scheduleHint}</p>}</section>
    <footer>凭证保存在当前 Windows 用户的应用数据目录 · 不会写入项目目录</footer>
  </main>;
}
function Step({ n, title, active, done }: { n: string; title: string; active?: boolean; done?: boolean }) { return <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : n}</span><b>{title}</b></div>; }
createRoot(document.getElementById('root')!).render(<App />);
