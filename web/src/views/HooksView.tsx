import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n, fmtDateTime } from '../i18n';
import { Icon } from '../components/Icon';
import type { Hook } from '../types';

const EVENTS = [
  'session.started', 'session.running', 'session.idle', 'turn.completed',
  'turn.error', 'agent.error', 'automation.started', 'automation.completed',
];

interface Draft {
  id?: string;
  name: string;
  event: string;
  sessionId: string;
  actionType: 'shell' | 'notify';
  command: string;
  enabled: boolean;
}

const emptyDraft = (): Draft => ({ name: '', event: 'turn.completed', sessionId: '', actionType: 'notify', command: '', enabled: true });

export function HooksView({ embedded }: { embedded?: boolean }) {
  const { t } = useI18n();
  const st = useStore();
  const hooks = useStore((s) => s.hooks);
  const runs = useStore((s) => s.hookRuns);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void st.refreshHooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const payload = {
      name: draft.name,
      event: draft.event,
      sessionId: draft.sessionId.trim() || null,
      actionType: draft.actionType,
      command: draft.command,
      enabled: draft.enabled,
    };
    const res = draft.id ? await fe.updateHook(draft.id, payload) : await fe.createHook(payload);
    setBusy(false);
    if ('error' in res) {
      st.toast('error', res.error);
      return;
    }
    setDraft(null);
    await st.refreshHooks();
  };

  return (
    <>
      {!embedded && (
        <div className="topbar">
          <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
          <h1><Icon name="hook" size={15} /> {t('hooks.title')}</h1>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => setDraft(emptyDraft())}><Icon name="plus" size={14} /> {t('hooks.new')}</button>
        </div>
      )}
      {embedded && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn primary" onClick={() => setDraft(emptyDraft())}><Icon name="plus" size={14} /> {t('hooks.new')}</button>
        </div>
      )}
      <div className="view-body narrow">
        {hooks.length === 0 && !draft && (
          <div style={{ color: 'var(--faint)', padding: '24px 0', textAlign: 'center' }}>{t('hooks.noHooks')}</div>
        )}
        {hooks.map((h: Hook) => (
          <div key={h.id} className="card" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name={h.actionType === 'shell' ? 'zap' : 'message'} size={13} /> {h.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="badge blue">{t(`hookEvent.${h.event}`)}</span>
                {h.sessionId && <span className="badge mono">{h.sessionId.slice(0, 13)}…</span>}
                {h.actionType === 'shell' && <span className="mono" style={{ fontSize: 11.5 }}>{h.command}</span>}
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={h.enabled}
                onChange={(e) => void fe.updateHook(h.id, { enabled: e.target.checked }).then(() => st.refreshHooks())}
              />
              <span className="track" />
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn sm"
                onClick={async () => {
                  const r = await fe.testHook(h.id);
                  if ('error' in r) st.toast('error', r.error);
                  else st.toast('info', h.name, 'test fired');
                }}
              >
                {t('hooks.test')}
              </button>
              <button
                className="btn sm"
                onClick={() => setDraft({ id: h.id, name: h.name, event: h.event, sessionId: h.sessionId || '', actionType: h.actionType, command: h.command || '', enabled: h.enabled })}
              >
                {t('common.edit')}
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!window.confirm(t('common.confirmDelete'))) return;
                  await fe.deleteHook(h.id);
                  await st.refreshHooks();
                }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}

        {runs.length > 0 && (
          <>
            <h2 style={{ fontSize: 14, margin: '18px 0 10px' }}>{t('hooks.runs')}</h2>
            <table className="table">
              <thead>
                <tr><th>time</th><th>{t('hooks.name')}</th><th>{t('hooks.event')}</th><th>status</th><th>output</th></tr>
              </thead>
              <tbody>
                {runs.slice(0, 50).map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {draft && (
        <div className="modal-overlay" onClick={() => setDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2><Icon name="hook" size={15} /> {draft.id ? t('common.edit') : t('hooks.new')}</h2>
            <div className="field">
              <label>{t('hooks.name')}</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('hooks.event')}</label>
              <select className="input" value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value })}>
                {EVENTS.map((ev) => (
                  <option key={ev} value={ev}>{t(`hookEvent.${ev}`)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t('hooks.sessionFilter')}</label>
              <input className="input mono" placeholder={t('hooks.sessionFilterHint')} value={draft.sessionId} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('hooks.action')}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className={`btn sm ${draft.actionType === 'notify' ? 'primary' : ''}`} onClick={() => setDraft({ ...draft, actionType: 'notify' })}><Icon name="message" size={12} /> {t('hooks.actionNotify')}</button>
                <button className={`btn sm ${draft.actionType === 'shell' ? 'primary' : ''}`} onClick={() => setDraft({ ...draft, actionType: 'shell' })}><Icon name="zap" size={12} /> {t('hooks.actionShell')}</button>
              </div>
            </div>
            {draft.actionType === 'shell' && (
              <div className="field">
                <label>{t('hooks.command')}</label>
                <input className="input mono" placeholder="echo %G4D_EVENT%" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                <div className="hint">{t('hooks.commandHint')}</div>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button className="btn primary" disabled={busy || !draft.name.trim() || (draft.actionType === 'shell' && !draft.command.trim())} onClick={() => void save()}>
                {busy ? t('common.saving') : t('hooks.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RunRow({ run }: { run: { id: string; hookName: string; event: string; at: number; ok: boolean; exitCode: number | null; output: string } }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(run.at)}</td>
        <td>{run.hookName}</td>
        <td>{t(`hookEvent.${run.event}`) || run.event}</td>
        <td>
          {run.ok ? <span className="badge green">✓</span> : <span className="badge red">✕ {run.exitCode ?? ''}</span>}
        </td>
        <td><button className="btn sm" onClick={() => setOpen(!open)}><Icon name="file" size={12} /></button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <pre className="code-block" style={{ maxHeight: 200 }}>{run.output || '—'}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
