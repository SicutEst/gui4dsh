import React, { useEffect, useMemo, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n, fmtTokens } from '../i18n';
import { Icon } from '../components/Icon';
import type { DayStat, StatsPayload } from '../types';

export function StatsView({ embedded }: { embedded?: boolean }) {
  const { t, locale } = useI18n();
  const st = useStore();
  const [data, setData] = useState<StatsPayload | null>(null);
  const [selDay, setSelDay] = useState<string | null>(null);

  useEffect(() => {
    fe.stats(366).then(setData).catch(() => st.toast('error', t('common.error')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byDate = useMemo(() => {
    const m = new Map<string, DayStat>();
    for (const d of data?.daily || []) m.set(d.date, d);
    return m;
  }, [data]);

  // local-date key for today
  const localToday = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const todayStat = byDate.get(localToday);

  const weeks = useMemo(() => {
    // build 53-week grid ending today
    const cells: Array<{ key: string; date: Date | null; stat?: DayStat }> = [];
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 370);
    // align to Monday
    const dow = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dow);
    const months: Array<{ index: number; label: string }> = [];
    const cur = new Date(start);
    let lastMonth = -1;
    let idx = 0;
    while (cur <= end) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
      cells.push({ key, date: new Date(cur), stat: byDate.get(key) });
      if (cur.getMonth() !== lastMonth) {
        lastMonth = cur.getMonth();
        months.push({ index: idx, label: locale === 'zh' ? `${lastMonth + 1}月` : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][lastMonth] });
      }
      cur.setDate(cur.getDate() + 1);
      idx++;
    }
    return { cells, months, total: idx };
  }, [byDate, locale]);

  const maxScore = useMemo(() => {
    let m = 0;
    for (const c of weeks.cells) {
      const s = score(c.stat);
      if (s > m) m = s;
    }
    return m || 1;
  }, [weeks]);

  const level = (stat?: DayStat): number => {
    if (!stat) return 0;
    const s = score(stat);
    if (!s) return 0;
    const r = s / maxScore;
    return r > 0.6 ? 4 : r > 0.3 ? 3 : r > 0.1 ? 2 : 1;
  };

  const last30 = useMemo(() => {
    const out: DayStat[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push(byDate.get(key) || { date: key, prompts: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 });
    }
    return out;
  }, [byDate]);
  const maxTurns = Math.max(1, ...last30.map((d) => d.turns));

  const sel = selDay ? byDate.get(selDay) : null;

  return (
    <>
      {!embedded && (
        <div className="topbar">
          <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
          <h1><Icon name="chart" size={15} /> {t('stats.title')}</h1>
        </div>
      )}
      <div className="view-body">
        <div className="stat-cards">
          <div className="card stat-card">
            <div className="num">{todayStat?.turns ?? 0}</div>
            <div className="lbl">{t('stats.today')} · {t('stats.turns')}</div>
          </div>
          <div className="card stat-card">
            <div className="num">{todayStat?.prompts ?? 0}</div>
            <div className="lbl">{t('stats.today')} · {t('stats.prompts')}</div>
          </div>
          <div className="card stat-card">
            <div className="num">{fmtTokens(((todayStat?.tokensIn || 0) + (todayStat?.tokensOut || 0) + (todayStat?.cacheRead || 0)))}</div>
            <div className="lbl">{t('stats.today')} · {t('stats.tokens')}</div>
          </div>
          <div className="card stat-card">
            <div className="num">{data?.totals.turns ?? 0}</div>
            <div className="lbl">{t('stats.total')} · {t('stats.turns')}</div>
          </div>
          <div className="card stat-card">
            <div className="num">{fmtTokens((data?.totals.tokensIn || 0) + (data?.totals.tokensOut || 0))}</div>
            <div className="lbl">{t('stats.total')} · {t('stats.tokens')}</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, marginBottom: 12 }}>{t('stats.heatmap')}</h2>
          <div className="heatmap-scroll">
            <div style={{ display: 'flex' }}>
              <div className="hm-days">
                <span />
                <span>{t('week.mon')}</span>
                <span />
                <span>{t('week.wed')}</span>
                <span />
                <span>{t('week.fri')}</span>
                <span />
              </div>
              <div>
                <div className="hm-months">
                  {weeks.months.map((m, i) => (
                    <span key={i} style={{ gridColumn: m.index + 1 }}>{m.label}</span>
                  ))}
                </div>
                <div className="heatmap">
                  {weeks.cells.map((c, i) => {
                    const lv = level(c.stat);
                    const title = c.date
                      ? `${c.key} · ${c.stat ? `${t('stats.turns')}: ${c.stat.turns}, ${t('stats.prompts')}: ${c.stat.prompts}, ${fmtTokens(c.stat.tokensIn + c.stat.tokensOut)} tokens` : '—'}`
                      : '';
                    return (
                      <div
                        key={i}
                        className={`hm-cell ${lv ? `h${lv}` : ''}`}
                        title={title}
                        onClick={() => setSelDay(c.date ? c.key : null)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="hm-legend">
            {t('stats.less')}
            <span className="hm-cell" />
            <span className="hm-cell h1" />
            <span className="hm-cell h2" />
            <span className="hm-cell h3" />
            <span className="hm-cell h4" />
            {t('stats.more')}
          </div>
          {sel && selDay && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--dim)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <b>{selDay}</b> · {t('stats.turns')}: {sel.turns} · {t('stats.prompts')}: {sel.prompts} · {t('stats.sessions')}: {sel.sessions} ·
              in {fmtTokens(sel.tokensIn)} / out {fmtTokens(sel.tokensOut)} / cache {fmtTokens(sel.cacheRead)}
            </div>
          )}
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, marginBottom: 4 }}>{t('stats.last30')} · {t('stats.turns')}</h2>
          <div className="bars">
            {last30.map((d) => (
              <div
                key={d.date}
                className="bar"
                style={{ height: `${(d.turns / maxTurns) * 100}%` }}
                title={`${d.date} · ${d.turns}`}
                onClick={() => setSelDay(d.date)}
              />
            ))}
          </div>
        </div>

        <div className="card">
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>{t('stats.modelUsage')}</h2>
          {(data?.models || []).length === 0 && <div style={{ color: 'var(--faint)', fontSize: 12.5 }}>{t('stats.noData')}</div>}
          {(data?.models || []).slice(0, 12).map((m) => {
            const total = m.tokensIn + m.tokensOut;
            const max = Math.max(1, ...(data?.models || []).map((x) => x.tokensIn + x.tokensOut));
            return (
              <div key={`${m.provider}/${m.model}`} className="model-row">
                <div className="m-name" title={`${m.provider}/${m.model}`}>{m.provider}/{m.model}</div>
                <div className="m-bar"><i style={{ width: `${(total / max) * 100}%` }} /></div>
                <div className="m-val">{fmtTokens(total)} · {m.turns}T</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function score(d?: DayStat): number {
  if (!d) return 0;
  return d.turns * 2 + d.prompts;
}
