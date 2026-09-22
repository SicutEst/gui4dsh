import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n, relTime } from '../i18n';
import { Icon } from './Icon';

interface IdleTaskView {
  id: string;
  prompt: string;
  cwd?: string;
  createdAt: number;
  status: string;
  sessionId?: string;
  startedAt?: number;
  error?: string;
}

/** Deferred prompts the gateway dispatches once no session has run for the idle window. */
export function IdleQueueCard() {
  const { t, locale } = useI18n();
  const st = useStore();
  const workspaces = useStore((s) => s.workspaces);
  const [enabled, setEnabled] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [tasks, setTasks] = useState<IdleTaskView[]>([]);
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [open, setOpen] = useState(false);

  const load = async () => {
    const r = await fe.idleState();
    if ('tasks' in (r as object)) {
      setEnabled((r as any).enabled);
      setMinutes((r as any).idleMinutes || 10);
      setTasks((r as any).tasks || []);
    }
  };

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, []);

  const pending = tasks.filter((x) => x.status === 'pending').length;
  const running = tasks.filter((x) => x.status === 'running').length;

  const add = async () => {
    if (!prompt.trim()) return;
    const r = await fe.idleAddTask(prompt, cwd || undefined);
    if (!r.ok) return;
    setPrompt('');
    await load();
  };

  const statusDot = (s: string) =>
    s === 'running' ? 'live' : s === 'done' ? 'ok' : s === 'failed' ? 'err' : '';

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <Icon name="calendar" size={14} />
        <b style={{ fontSize: 13.5 }}>{t('idle.title')}</b>
        {enabled ? (
          <span className="badge">{locale === 'zh' ? `空闲 ${minutes} 分钟后执行` : `runs after ${minutes}min idle`}</span>
        ) : (
          <span className="badge" style={{ opacity: 0.6 }}>{t('idle.off')}</span>
        )}
        {pending > 0 && <span className="badge">{t('idle.pending', { n: pending })}</span>}
        {running > 0 && <span className="badge" style={{ color: 'var(--accent)' }}>{t('idle.runningBadge')}</span>}
        <div style={{ flex: 1 }} />
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void fe.idleConfig(e.target.checked, minutes).then(() => void load())}
          />
          <span className="track" />
        </label>
        <button className="btn sm" onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder={t('idle.promptPh')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
            />
            <select className="input" style={{ width: 170 }} value={cwd} onChange={(e) => setCwd(e.target.value)}>
              <option value="">{t('idle.anyWorkspace')}</option>
              {workspaces.map((w) => (
                <option key={w.workspaceId} value={(w as any).cwd || w.title}>{w.title}</option>
              ))}
            </select>
            <button className="btn sm primary" onClick={() => void add()} disabled={!prompt.trim()}>
              <Icon name="plus" size={12} /> {t('idle.add')}
            </button>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>
              {locale === 'zh' ? '空闲' : 'idle'} ≥
              <input
                className="input"
                style={{ width: 46, margin: '0 4px', padding: '2px 6px' }}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value) || 10)}
                onBlur={() => void fe.idleConfig(enabled, minutes).then(() => void load())}
              />
              {locale === 'zh' ? '分钟' : 'min'}
            </span>
          </div>
          {tasks.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tasks.slice().reverse().map((x) => (
                <div key={x.id} className="idle-row">
                  <span className={`jobs-dot ${statusDot(x.status)}`} />
                  <span className="idle-prompt" title={x.prompt}>{x.prompt}</span>
                  <span className="idle-meta">
                    {x.cwd ? x.cwd.split(/[\\/]/).pop() + ' · ' : ''}
                    {x.status === 'pending' && t('idle.stPending')}
                    {x.status === 'running' && t('idle.stRunning')}
                    {x.status === 'done' && (x.startedAt ? relTime(x.startedAt, locale) : t('idle.stDone'))}
                    {x.status === 'failed' && (x.error || t('idle.stFailed'))}
                  </span>
                  {x.sessionId && (
                    <button className="btn sm" onClick={() => void st.openSession(x.sessionId!)}>
                      <Icon name="external" size={11} />
                    </button>
                  )}
                  {x.status === 'pending' && (
                    <button className="btn sm danger" onClick={() => void fe.idleRemoveTask(x.id).then(() => void load())}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
