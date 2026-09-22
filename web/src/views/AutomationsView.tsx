import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n, relTime, fmtDateTime } from '../i18n';
import { Icon } from '../components/Icon';
import { IdleQueueCard } from '../components/IdleQueue';
import type { Automation, AutomationRun } from '../types';

type CronMode = 'everyNMin' | 'hourlyAt' | 'daily' | 'weekly' | 'custom';

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  mode: CronMode;
  everyN: number;
  atMinute: number;
  timeHHmm: string;
  weekday: number;
  cron: string;
  timeoutMin: number;
  enabled: boolean;
}

function cronFromDraft(d: Draft): string {
  switch (d.mode) {
    case 'everyNMin': return `*/${Math.max(1, d.everyN)} * * * *`;
    case 'hourlyAt': return `${clamp(d.atMinute, 0, 59)} * * * *`;
    case 'daily': {
      const [h, m] = parseHHmm(d.timeHHmm);
      return `${m} ${h} * * *`;
    }
    case 'weekly': {
      const [h, m] = parseHHmm(d.timeHHmm);
      return `${m} ${h} * * ${d.weekday}`;
    }
    default: return d.cron;
  }
}

function parseHHmm(s: string): [number, number] {
  const [h, m] = s.split(':').map(Number);
  return [clamp(h || 0, 0, 23), clamp(m || 0, 0, 59)];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function draftFromAutomation(a: Automation): Draft {
  const parts = a.cron.trim().split(/\s+/);
  let mode: CronMode = 'custom';
  if (/^\*\/\d+$/.test(parts[0]) && parts[1] === '*' && parts[2] === '*' && parts[3] === '*') mode = 'everyNMin';
  else if (/^\d+$/.test(parts[0]) && parts[1] === '*' && parts[2] === '*') mode = 'hourlyAt';
  else if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*') mode = 'daily';
  else if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && /^\d+$/.test(parts[4] || '')) mode = 'weekly';
  return {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    mode,
    everyN: Number(parts[0]?.replace('*/', '')) || 30,
    atMinute: Number(parts[0]) || 0,
    timeHHmm: `${clamp(Number(parts[1]) || 0, 0, 23).toString().padStart(2, '0')}:${clamp(Number(parts[0]) || 0, 0, 59).toString().padStart(2, '0')}`,
    weekday: Number(parts[4]) || 1,
    cron: a.cron,
    timeoutMin: a.timeoutMin,
    enabled: a.enabled,
  };
}

const emptyDraft = (): Draft => ({
  name: '', prompt: '', mode: 'daily', everyN: 30, atMinute: 0, timeHHmm: '09:00', weekday: 1, cron: '0 9 * * *', timeoutMin: 30, enabled: true,
});

export function AutomationsView() {
  const { t, locale } = useI18n();
  const st = useStore();
  const automations = useStore((s) => s.automations);
  const runs = useStore((s) => s.automationRuns);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void st.refreshAutomations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const payload = {
      name: draft.name,
      prompt: draft.prompt,
      cron: cronFromDraft(draft),
      timeoutMin: draft.timeoutMin,
      enabled: draft.enabled,
    };
    const res = draft.id
      ? await fe.updateAutomation(draft.id, payload)
      : await fe.createAutomation(payload);
    setBusy(false);
    if ('error' in res) {
      st.toast('error', res.error);
      return;
    }
    setDraft(null);
    await st.refreshAutomations();
  };

  const cronDesc = (cron: string): string => {
    const p = cron.trim().split(/\s+/);
    const zh = locale === 'zh';
    if (/^\*\/(\d+)$/.test(p[0]) && p[1] === '*') return zh ? `每 ${p[0].slice(2)} 分钟` : `every ${p[0].slice(2)} min`;
    if (/^\d+$/.test(p[0]) && p[1] === '*') return zh ? `每小时第 ${p[0]} 分` : `hourly at :${p[0]}`;
    if (/^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') return zh ? `每天 ${p[1]}:${p[0].padStart(2, '0')}` : `daily ${p[1]}:${p[0].padStart(2, '0')}`;
    if (/^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[4] !== undefined) {
      const names = zh ? ['日', '一', '二', '三', '四', '五', '六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `${zh ? '每周' : 'weekly '}${names[Number(p[4]) % 7]} ${p[1]}:${p[0].padStart(2, '0')}`;
    }
    return cron;
  };

  const shownRuns = runsFor ? runs.filter((r) => r.automationId === runsFor) : runs.slice(0, 30);

  return (
    <>
      <div className="topbar">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <h1><Icon name="clock" size={15} /> {t('auto.title')}</h1>
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setDraft(emptyDraft())}><Icon name="plus" size={14} /> {t('auto.new')}</button>
      </div>
      <div className="view-body narrow">
        <IdleQueueCard />
        {automations.length === 0 && !draft && (
          <div style={{ color: 'var(--faint)', padding: '30px 0', textAlign: 'center' }}>{t('auto.noAutomations')}</div>
        )}
        {automations.map((a) => (
          <div key={a.id} className="card auto-card" style={{ marginBottom: 12 }}>
            <div className="a-main">
              <div className="a-name">
                {a.name}
                {a.lastError && <span className="badge red" style={{ marginLeft: 8 }}>{t('auto.invalidCron')}</span>}
              </div>
              <div className="a-cron">{a.cron} · {cronDesc(a.cron)}</div>
              <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                {t('auto.nextRun')}: {a.enabled && a.nextRunAt ? fmtDateTime(a.nextRunAt) : '—'} · {t('auto.lastRun')}: {a.lastRunAt ? relTime(a.lastRunAt, locale) : t('auto.never')} · {a.runCount} runs
              </div>
              <div className="a-prompt">{a.prompt}</div>
            </div>
            <div className="auto-actions">
              <label className="switch">
                <input type="checkbox" checked={a.enabled} onChange={(e) => void fe.updateAutomation(a.id, { enabled: e.target.checked }).then(() => st.refreshAutomations())} />
                <span className="track" />
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={() => setDraft(draftFromAutomation(a))}>{t('auto.edit')}</button>
                <button
                  className="btn sm primary"
                  onClick={async () => {
                    st.toast('info', `${a.name} · ${t('auto.running')}…`);
                    const r = await fe.runAutomation(a.id);
                    if ('error' in r) st.toast('error', r.error);
                    await st.refreshAutomations();
                  }}
                >
                  <Icon name="play" size={12} /> {t('auto.runNow')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" onClick={() => setRunsFor(runsFor === a.id ? null : a.id)}>{t('auto.history')}</button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (!window.confirm(t('common.confirmDelete'))) return;
                    await fe.deleteAutomation(a.id);
                    await st.refreshAutomations();
                  }}
                >
                  {t('auto.delete')}
                </button>
              </div>
            </div>
          </div>
        ))}

        {shownRuns.length > 0 && (
          <>
            <h2 style={{ fontSize: 14, margin: '18px 0 10px' }}>{t('auto.history')}{runsFor ? '' : ' (30)'}</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('auto.name')}</th>
                  <th>{t('auto.trigger.cron')}/{t('auto.trigger.manual')}</th>
                  <th>time</th>
                  <th>status</th>
                  <th>output</th>
                </tr>
              </thead>
              <tbody>
                {shownRuns.map((r: AutomationRun) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {draft && (
        <div className="modal-overlay" onClick={() => setDraft(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h2><Icon name="clock" size={15} /> {draft.id ? t('auto.edit') : t('auto.new')}</h2>
            <div className="field">
              <label>{t('auto.name')}</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('auto.prompt')}</label>
              <textarea className="input" rows={4} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('auto.cronMode')}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['everyNMin', 'hourlyAt', 'daily', 'weekly', 'custom'] as CronMode[]).map((m) => (
                  <button key={m} className={`btn sm ${draft.mode === m ? 'primary' : ''}`} onClick={() => setDraft({ ...draft, mode: m })}>
                    {t(`auto.${m}`)}
                  </button>
                ))}
              </div>
            </div>
            {draft.mode === 'everyNMin' && (
              <div className="field">
                <label>{t('auto.minutes')}</label>
                <input className="input" type="number" min={1} value={draft.everyN} onChange={(e) => setDraft({ ...draft, everyN: Number(e.target.value) })} />
              </div>
            )}
            {draft.mode === 'hourlyAt' && (
              <div className="field">
                <label>{t('auto.atMinute')}</label>
                <input className="input" type="number" min={0} max={59} value={draft.atMinute} onChange={(e) => setDraft({ ...draft, atMinute: Number(e.target.value) })} />
              </div>
            )}
            {(draft.mode === 'daily' || draft.mode === 'weekly') && (
              <div className="field">
                <label>{t('auto.time')}</label>
                <input className="input" type="time" value={draft.timeHHmm} onChange={(e) => setDraft({ ...draft, timeHHmm: e.target.value })} />
              </div>
            )}
            {draft.mode === 'weekly' && (
              <div className="field">
                <label>{t('auto.weekday')}</label>
                <select className="input" value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>
                  {(locale === 'zh' ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']).map((d, i) => (
                    <option key={i} value={i}>{d}</option>
                  ))}
                </select>
              </div>
            )}
            {draft.mode === 'custom' && (
              <div className="field">
                <label>{t('auto.cron')}</label>
                <input className="input mono" placeholder="m h dom mon dow" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} />
                <div className="hint">{cronDesc(draft.cron)}</div>
              </div>
            )}
            <div className="field">
              <label>{t('auto.timeout')}</label>
              <input className="input" type="number" min={1} value={draft.timeoutMin} onChange={(e) => setDraft({ ...draft, timeoutMin: Number(e.target.value) })} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDraft(null)}>{t('auto.cancel')}</button>
              <button className="btn primary" disabled={busy || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void save()}>
                {busy ? t('common.saving') : t('auto.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RunRow({ run }: { run: AutomationRun }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const badge = run.finishedAt === null
    ? <span className="badge yellow">{t('auto.running')}</span>
    : run.timedOut
      ? <span className="badge red">{t('auto.timeoutReached')}</span>
      : run.ok
        ? <span className="badge green">{t('auto.ok')}</span>
        : <span className="badge red">{t('auto.fail')} {run.exitCode ?? ''}</span>;
  return (
    <>
      <tr>
        <td>{run.automationName}</td>
        <td>{t(`auto.trigger.${run.trigger}`)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(run.startedAt)}</td>
        <td>{badge}</td>
        <td>
          <button className="btn sm" onClick={() => setOpen(!open)}><Icon name="file" size={12} /></button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <pre className="code-block" style={{ maxHeight: 260 }}>{run.output || '—'}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
