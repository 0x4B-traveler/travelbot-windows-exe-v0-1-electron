import React, { useEffect, useState } from 'react';
import type { GroupMessageConfigView } from '../domain/business';
import { Card, Field, Notice, useAction } from '../ui';

export type ConnectionState = 'checking' | 'unauthorized' | 'authorizing' | 'authorized' | 'error';

/** 设置：企业微信机器人扫码授权、客户群群发配置。不属于核心业务模块。 */
export function SettingsPage({ connection, onConnectionChange }: { connection: ConnectionState; onConnectionChange: (state: ConnectionState) => void }) {
  return <>
    <AuthCard state={connection} onChange={onConnectionChange} />
    <GroupMessageConfigCard />
  </>;
}

export async function checkAuth(): Promise<{ state: ConnectionState; detail: string }> {
  const result = await window.travelbot.authStatus();
  if (result.ok && result.stdout?.trim().toLowerCase() === 'authorized') return { state: 'authorized', detail: '企业微信机器人已授权' };
  return { state: result.ok ? 'unauthorized' : 'error', detail: result.ok ? '尚未授权，请扫码绑定企业微信' : (result.stderr || '授权状态检查失败') };
}

function AuthCard({ state, onChange }: { state: ConnectionState; onChange: (state: ConnectionState) => void }) {
  const [detail, setDetail] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const check = async () => { const result = await checkAuth(); if (state !== 'authorizing' || result.state === 'authorized') { onChange(result.state); setDetail(result.detail); } };
  useEffect(() => { void check(); }, []);
  useEffect(() => {
    if (state !== 'authorizing') return;
    const timer = window.setInterval(() => { void check(); }, 2500);
    return () => window.clearInterval(timer);
  }, [state]);
  const authorize = async () => {
    onChange('authorizing'); setDetail('正在生成二维码，扫码后请在企业微信中确认（最多等待 5 分钟）'); setQr(null); setQrSrc(null);
    const result = await window.travelbot.startAuth();
    if (result.qrcode) setQr(result.qrcode);
    if (result.qrcodeDataUrl) setQrSrc(result.qrcodeDataUrl);
    if (result.ok && result.pending) setDetail('二维码已生成，请立即使用企业微信扫码并确认');
    else if (result.ok) { onChange('authorized'); setDetail('连接成功！企业微信授权已保存到本机'); }
    else { onChange('error'); setDetail(result.stderr || '授权未完成'); }
  };
  const connected = state === 'authorized';
  return <Card title="企业微信机器人" extra={<button className="refresh-button" onClick={() => void check()} disabled={state === 'authorizing'} title="刷新连接状态"><span>↻</span></button>}>
    <div className="connection"><div className={`icon ${connected ? 'authorized' : state}`}><span>{connected ? '✓' : '↗'}</span></div><div><strong>{connected ? '企业微信已连接' : state === 'checking' ? '正在检查…' : '等待企业微信授权'}</strong><p>{detail}</p></div></div>
    {qr && state === 'authorizing' && <div className="qr-box">{qrSrc ? <img src={qrSrc} alt="企业微信授权二维码" /> : <p className="hint">二维码预览加载失败，请点右侧在系统中打开</p>}<button className="link" onClick={() => void window.travelbot.openImage(qr)}>在系统中打开二维码</button></div>}
    <p className="hint">授权后，“群管理”里刷新就能看到机器人所在的群。把机器人拉进群并在群里给它发一条消息，群才会出现在列表里。</p>
    <div className="actions"><button className="primary" onClick={() => void authorize()} disabled={state === 'authorizing'}>{connected ? '重新扫码授权' : '扫码授权'}</button></div>
  </Card>;
}

function GroupMessageConfigCard() {
  const [config, setConfig] = useState<GroupMessageConfigView | null>(null);
  const [corpId, setCorpId] = useState('');
  const [senderUserId, setSenderUserId] = useState('');
  const [secret, setSecret] = useState('');
  const { busy, notice, run } = useAction();
  useEffect(() => { void window.travelbot.groupMessageConfig().then(view => { setConfig(view); setCorpId(view.corpId); setSenderUserId(view.senderUserId); }); }, []);
  return <Card title="客户群群发">
    <p className="hint">用于向客户群发送：通过企业微信“客户群群发”接口创建任务，群主在企业微信里确认后发出。运行本程序的电脑公网 IP 需加入应用的“企业可信 IP”。</p>
    <div className="form-grid">
      <Field label="企业 ID（corpid）"><input value={corpId} onChange={event => setCorpId(event.target.value)} /></Field>
      <Field label="发送人 userid（群主）"><input value={senderUserId} onChange={event => setSenderUserId(event.target.value)} /></Field>
    </div>
    <Field label="客户联系 Secret"><input type="password" value={secret} placeholder={config?.hasSecret ? '已保存，留空则不修改' : '在管理后台“客户联系”中获取'} onChange={event => setSecret(event.target.value)} autoComplete="off" /></Field>
    {config && !config.encryptionAvailable && <p className="notice error">当前系统不支持加密存储，无法保存 Secret。</p>}
    <Notice notice={notice} />
    <div className="actions"><button className="primary" disabled={busy || !corpId.trim() || !senderUserId.trim() || (!secret.trim() && !config?.hasSecret)} onClick={() => void run(async () => {
      const result = await window.travelbot.saveGroupMessageConfig({ corpId, senderUserId, secret });
      if (!result.ok || !result.config) throw new Error(result.stderr || '保存失败');
      setConfig(result.config); setSecret('');
      return '配置已保存，Secret 已加密存储在本机。到“群管理”刷新即可加载客户群。';
    })}>保存配置</button></div>
  </Card>;
}
