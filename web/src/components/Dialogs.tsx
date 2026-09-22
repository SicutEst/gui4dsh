import React, { useEffect, useState } from 'react';
import { dshCall } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Markdown } from './blocks';
import { Icon } from './Icon';
import type { AgentPresetEntry, ApprovalPending, QuestionPending } from '../types';

export function ApprovalDialog({ approval }: { approval: ApprovalPending }) {
  const { t } = useI18n();
  const st = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2><Icon name="shield" size={16} /> {t('chat.approvalTitle')}</h2>
        <div className="card" style={{ marginBottom: 12, background: 'var(--bg2)' }}>
          <div style={{ fontFamily: 'Cascadia Code, Consolas, monospace', fontWeight: 700, fontSize: 14 }}>
            {approval.toolName}
          </div>
          {approval.reason && <div style={{ fontSize: 12.5, color: 'var(--dim)', marginTop: 6 }}>{approval.reason}</div>}
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 8 }} className="mono">
            session {approval.sessionId.slice(0, 13)}…
          </div>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await st.respondApproval(approval.sessionId, 'rejected');
            }}
          >
            {t('chat.reject')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await st.respondApproval(approval.sessionId, 'allowed-once');
            }}
          >
            {t('chat.approve')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function QuestionDialog({ question }: { question: QuestionPending }) {
  const { t } = useI18n();
  const st = useStore();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const submit = async () => {
    const answers = question.questions.map((q) => ({
      id: q.id,
      selected: selected[q.id] || [],
      custom: custom[q.id] || undefined,
    }));
    await st.respondQuestion(question.sessionId, { answers });
  };

  const allAnswered = question.questions.every((q) => {
    const sel = selected[q.id] || [];
    return sel.length > 0 || (custom[q.id] || '').trim().length > 0;
  });

  return (
    <div className="modal-overlay">
      <div className="modal wide">
        <h2><Icon name="message" size={16} /> {t('chat.questionTitle')}</h2>
        {question.questions.map((q) => {
          const isPlan = q.intent?.kind === 'plan-review';
          const sel = selected[q.id] || [];
          return (
            <div key={q.id} className="card" style={{ marginBottom: 12 }}>
              {q.header && <div className="badge violet" style={{ marginBottom: 6 }}>{q.header}</div>}
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                {isPlan && <Icon name="file" size={13} />} {q.question}
              </div>
              {isPlan && q.detail && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, maxHeight: 300, overflowY: 'auto', marginBottom: 8 }}>
                  <Markdown text={q.detail} />
                </div>
              )}
              {!isPlan && q.detail && (
                <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{q.detail}</div>
              )}
              {q.options && q.options.length > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {q.options.map((o) => {
                    const on = sel.includes(o.label);
                    const approveOpt = isPlan && q.intent?.approve === o.label;
                    return (
                      <button
                        key={o.label}
                        className={`btn ${on ? (approveOpt ? 'primary' : '') : ''}`}
                        style={{
                          textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2,
                          borderColor: on ? (approveOpt ? undefined : 'var(--green)') : undefined,
                        }}
                        onClick={() => {
                          if (q.multiSelect) {
                            setSelected({ ...selected, [q.id]: on ? sel.filter((x) => x !== o.label) : [...sel, o.label] });
                          } else {
                            setSelected({ ...selected, [q.id]: [o.label] });
                            setCustom({ ...custom, [q.id]: '' });
                          }
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: 4, border: `1.5px solid ${on ? 'var(--green)' : 'var(--border2)'}`, background: on ? 'var(--green)' : 'transparent' }}>
                            {on && <Icon name="check" size={10} />}
                          </span>
                          {o.label}
                          {approveOpt && <span className="badge green" style={{ marginLeft: 4 }}>approve</span>}
                        </span>
                        {o.description && <span style={{ fontSize: 11.5, color: 'var(--dim)', fontWeight: 400 }}>{o.description}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <input
                className="input"
                style={{ marginTop: 8 }}
                placeholder={t('chat.answerOther')}
                value={custom[q.id] || ''}
                onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })}
              />
            </div>
          );
        })}
        <div className="modal-actions">
          <button className="btn primary" disabled={!allAnswered} onClick={() => void submit()}>
            {t('chat.answer')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NewTaskModal() {
  const { t } = useI18n();
  const open = useStore((s) => s.newTaskModal);
  const st = useStore();
  const workspaces = useStore((s) => s.workspaces);
  const [presets, setPresets] = useState<AgentPresetEntry[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [preset, setPreset] = useState('');
  const [perm, setPerm] = useState<'workspace-write' | 'danger-full-access'>('workspace-write');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setWorkspaceId('');
      setPreset('');
      setPerm('workspace-write');
      setPrompt('');
      dshCall<{ presets: AgentPresetEntry[] }>('agentPreset.list', {}).then((r) => {
        if (r.ok) setPresets((r.value?.presets || []).filter((p) => !p.broken));
      });
      dshCall<{ namespaces: Array<{ ns: string; value?: { defaultPreset?: string } }> }>('settings.describe', {}).then((r) => {
        if (r.ok) {
          const ns = r.value?.namespaces?.find((n) => n.ns === 'permission');
          if (ns?.value?.defaultPreset === 'danger-full-access') setPerm('danger-full-access');
          else setPerm('workspace-write');
        }
      });
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => !busy && st.setNewTaskModal(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><Icon name="sparkles" size={16} /> {t('newTask.title')}</h2>
        <div className="field">
          <label>{t('newTask.project')}</label>
          <select className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">{t('newTask.defaultProject')}</option>
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>{w.title} — {w.path}</option>
            ))}
          </select>
        </div>
        {presets.length > 0 && (
          <div className="field">
            <label>{t('newTask.preset')}</label>
            <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
              <option value="">{t('newTask.presetDefault')}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}{p.isDefault ? ' · default' : ''}{p.trust === 'user' ? ' (user)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>{t('newTask.perm')}</label>
          <select className="input" value={perm} onChange={(e) => setPerm(e.target.value as 'workspace-write' | 'danger-full-access')}>
            <option value="workspace-write">{t('chat.permStandard')}</option>
            <option value="danger-full-access">{t('chat.permYolo')}</option>
          </select>
        </div>
        <div className="field">
          <label>{t('newTask.prompt')}</label>
          <textarea
            className="input"
            placeholder={t('newTask.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => st.setNewTaskModal(false)}>{t('newTask.cancel')}</button>
          <button
            className="btn primary"
            disabled={busy || !prompt.trim()}
            onClick={async () => {
              setBusy(true);
              await dshCall('settings.update', { ns: 'permission', patch: { defaultPreset: perm } });
              const sid = await st.newTask({
                workspaceId: workspaceId || undefined,
                agentPreset: preset || undefined,
                prompt: prompt.trim(),
              });
              setBusy(false);
              if (sid) st.setNewTaskModal(false);
            }}
          >
            {busy ? t('common.loading') : t('newTask.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
