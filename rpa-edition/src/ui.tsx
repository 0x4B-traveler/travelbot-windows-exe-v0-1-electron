import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from './api';

// 各页面共用的小组件。

/** 加载数据并在依赖变化时刷新；返回 [数据, 错误, 重新加载]。 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): [T | null, string, () => Promise<void>] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setData(await loader()); setError(''); } catch (err) { setError(errorText(err)); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return [data, error, reload];
}

/** 执行一个操作，自动记录进行中状态和结果提示。 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const run = useCallback(async (action: () => Promise<string | void>) => {
    setBusy(true); setNotice(null);
    try { const message = await action(); if (message) setNotice({ kind: 'ok', text: message }); return true; }
    catch (err) { setNotice({ kind: 'error', text: errorText(err) }); return false; }
    finally { setBusy(false); }
  }, []);
  return { busy, notice, setNotice, run };
}

export function Notice({ notice }: { notice: { kind: 'ok' | 'error'; text: string } | null }) {
  if (!notice) return null;
  return <p className={`notice ${notice.kind}`}>{notice.text}</p>;
}

export function Card({ title, extra, children, className = '' }: { title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`card ops-card ${className}`}>
    {(title || extra) && <div className="card-title"><span>{title}</span>{extra && <span className="card-extra">{extra}</span>}</div>}
    {children}
  </section>;
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'fail' | 'info' | 'muted'; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; count?: number }>; onChange: (value: T) => void }) {
  return <div className="tabs">{options.map(option => <button key={option.value} className={`tab ${value === option.value ? 'active' : ''}`} onClick={() => onChange(option.value)}>
    {option.label}{option.count !== undefined && <em>{option.count}</em>}
  </button>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-mask" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`}>
      <div className="modal-head"><strong>{title}</strong><button className="link" onClick={onClose}>关闭</button></div>
      <div className="modal-body">{children}</div>
    </div>
  </div>;
}

/** group：里面是一组按钮或单选框时用 div，避免整块区域被当成一个 label 点击。 */
export function Field({ label, children, hint, group }: { label: string; children: React.ReactNode; hint?: string; group?: boolean }) {
  const Tag = group ? 'div' : 'label';
  return <Tag className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</Tag>;
}

export function Empty({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty"><p>{children}</p>{action}</div>;
}

export const splitTags = (text: string) => text.split(/[,，、/\s]+/).map(tag => tag.trim()).filter(Boolean);
