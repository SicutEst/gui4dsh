import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { TrajEv } from '../store';
import { Icon } from './Icon';

interface TrajRow {
  seq: number;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'context' | 'turn-end';
  time: number;
  endTime?: number;
  title: string;
  sub?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } | null;
  args?: string;
  resultPreview?: string;
  error?: string;
  pending?: boolean;
  step: number;
}

interface TrajTurn {
  index: number;
  startTime: number;
  endTime?: number;
  model?: string;
  rows: TrajRow[];
}

const KIND_COLOR: Record<TrajRow['kind'], string> = {
  user: '#4d6bfe',
  assistant: '#7b5cff',
  tool: '#21b384',
  system: '#9aa3af',
  context: '#b085f0',
  'turn-end': '#e05252',
};

function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return '';
  if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function fmtTok(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
}

function clockOf(t: number): string {
  if (!t) return '--:--:--';
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

/** Fold the ordered light event stream into turn-grouped ledger rows. */
function deriveTurns(evs: TrajEv[]): TrajTurn[] {
  const turns: TrajTurn[] = [];
  let turn: TrajTurn = { index: 0, startTime: 0, rows: [] }; // pre-turn preamble
  let step = 0;
  let stepStart = 0;
  const pendingTools = new Map<string, TrajRow>();
  for (const ev of evs) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'turn/start':
        turn = { index: turn.index + 1, startTime: ev.time, rows: [] };
        turns.push(turn);
        step = 0;
        stepStart = ev.time;
        break;
      case 'step/start':
        step += 1;
        stepStart = ev.time;
        break;
      case 'user/message': {
        const row: TrajRow = d.user
          ? { seq: ev.seq, kind: 'user', time: ev.time, step, title: d.text || '(input)', sub: [d.images ? `+${d.images}img` : '', d.files ? `+${d.files}file` : ''].filter(Boolean).join(' ') || undefined }
          : { seq: ev.seq, kind: 'context', time: ev.time, step, title: d.text || '(context)' };
        turn.rows.push(row);
        break;
      }
      case 'assistant/message': {
        turn.model = d.model ? `${d.provider || ''}/${d.model}` : turn.model;
        const bits: string[] = [];
        if (d.reasoning) bits.push('think');
        if (d.toolCalls) bits.push(`${d.toolCalls} call`);
        turn.rows.push({
          seq: ev.seq, kind: 'assistant', time: stepStart || ev.time, endTime: ev.time, step,
          title: d.text || bits.join(' · ') || '(model)',
          sub: d.usage ? `in ${fmtTok(d.usage.inputTokens)} · out ${fmtTok(d.usage.outputTokens)}${d.usage.cacheReadTokens ? ` · cache ${fmtTok(d.usage.cacheReadTokens)}` : ''}` : undefined,
          usage: d.usage,
        });
        break;
      }
      case 'tool/call': {
        const row: TrajRow = { seq: ev.seq, kind: 'tool', time: ev.time, step, title: d.name || 'tool', args: d.args, pending: true };
        turn.rows.push(row);
        if (d.callId) pendingTools.set(d.callId, row);
        break;
      }
      case 'tool/result': {
        const row = d.callId ? pendingTools.get(d.callId) : undefined;
        if (row) {
          row.pending = false;
          row.endTime = ev.time;
          if (d.error) row.error = d.preview || 'error';
          else row.resultPreview = d.preview;
          pendingTools.delete(d.callId);
        } else {
          turn.rows.push({ seq: ev.seq, kind: 'tool', time: ev.time, step, title: '?', resultPreview: d.preview, error: d.error ? d.preview || 'error' : undefined });
        }
        break;
      }
      case 'system/message':
        turn.rows.push({ seq: ev.seq, kind: 'system', time: ev.time, step, title: d.text || 'system' });
        break;
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
        turn.rows.push({ seq: ev.seq, kind: 'system', time: ev.time, step, title: `${ev.type.split('/')[0]}: ${d.value || ''}` });
        break;
      case 'turn/end':
        turn.endTime = ev.time;
        if (d.kind && d.kind !== 'completed') {
          turn.rows.push({ seq: ev.seq, kind: 'turn-end', time: ev.time, step, title: d.kind + (d.message ? `: ${d.message}` : '') });
        }
        break;
      default:
        if (ev.type.startsWith('compaction')) {
          turn.rows.push({ seq: ev.seq, kind: 'system', time: ev.time, step, title: 'compaction' });
        }
    }
  }
  // preamble (index 0) only kept when it has rows
  return turns.filter((t) => t.index > 0 || t.rows.length > 0);
}

/** Greedy lane assignment so bars never overlap in the overview. */
function layoutLanes(rows: TrajRow[]): Array<{ row: TrajRow; lane: number }> {
  const out: Array<{ row: TrajRow; lane: number }> = [];
  const laneEnds: number[] = [];
  for (const row of rows) {
    const end = row.endTime ?? row.time;
    let lane = laneEnds.findIndex((t) => t <= row.time);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = end;
    out.push({ row, lane });
  }
  return out;
}

export function TrajectoryView(props: {
  traj: TrajEv[];
  streaming: boolean;
  hasMore: boolean;
  loading: boolean;
  onLoadOlder: () => void;
}) {
  const { t, locale } = useI18n();
  const { traj, hasMore, loading, onLoadOlder } = props;
  const [zoomTurn, setZoomTurn] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const stickBottom = useRef(true);

  const allTurns = useMemo(() => deriveTurns(traj), [traj]);
  const turns = useMemo(
    () => (zoomTurn === null ? allTurns : allTurns.filter((x) => x.index === zoomTurn)),
    [allTurns, zoomTurn],
  );

  const bars = useMemo(() => {
    const rows = turns.flatMap((x) => x.rows);
    const withTime = rows.filter((r) => r.time > 0);
    return { lanes: layoutLanes(withTime), rows };
  }, [turns]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const lastSeq = traj.length ? traj[traj.length - 1].seq : 0;
  useLayoutEffect(() => {
    const el = ledgerRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastSeq, zoomTurn]);

  const domain = useMemo(() => {
    const times: number[] = [];
    for (const { row } of bars.lanes) {
      times.push(row.time, row.endTime ?? row.time);
    }
    if (!times.length) return null;
    const min = Math.min(...times);
    const max = Math.max(...times);
    return { min, max: Math.max(max, min + 1000) };
  }, [bars]);

  const jumpTo = (seq: number) => {
    setSelected(seq);
    const el = ledgerRef.current?.querySelector(`[data-traj-seq="${seq}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const H = 16;
  const laneCount = Math.min(8, Math.max(1, bars.lanes.length ? Math.max(...bars.lanes.map((b) => b.lane)) + 1 : 1));
  const svgH = laneCount * H + 22;

  return (
    <div className="traj" ref={wrapRef}>
      <div className="traj-overview">
        {domain ? (
          <svg
            width={width}
            height={svgH}
            style={{ display: 'block', cursor: 'pointer' }}
            onMouseDown={(e) => {
              // click on empty axis area clears the selection
              if (e.target === e.currentTarget) setZoomTurn(null);
            }}
          >
            {bars.lanes.map(({ row, lane }) => {
              const x1 = ((row.time - domain.min) / (domain.max - domain.min)) * (width - 16) + 8;
              const x2 = (( (row.endTime ?? row.time) - domain.min) / (domain.max - domain.min)) * (width - 16) + 8;
              const w = Math.max(2.5, x2 - x1);
              const isSel = selected === row.seq;
              return (
                <g key={row.seq} onClick={() => jumpTo(row.seq)}>
                  <title>{`${row.title.slice(0, 80)} · ${fmtMs(row.endTime ? row.endTime - row.time : undefined) || (row.pending ? '…' : '')}`}</title>
                  <rect
                    x={x1} y={lane * H + 4} width={w} height={H - 8} rx={3}
                    fill={row.kind === 'turn-end' ? 'transparent' : KIND_COLOR[row.kind]}
                    stroke={row.kind === 'turn-end' ? KIND_COLOR['turn-end'] : 'none'}
                    strokeWidth={1.5}
                    opacity={isSel ? 1 : row.pending ? 0.45 : 0.75}
                  />
                </g>
              );
            })}
            <text x={8} y={svgH - 6} fontSize={10} fill="var(--faint)">{clockOf(domain.min)}</text>
            <text x={width - 8} y={svgH - 6} fontSize={10} fill="var(--faint)" textAnchor="end">{clockOf(domain.max)}</text>
          </svg>
        ) : (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--faint)', textAlign: 'center' }}>
            {t('traj.empty')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, padding: '2px 8px 6px', fontSize: 11, color: 'var(--faint)', flexWrap: 'wrap' }}>
          {(['user', 'assistant', 'tool', 'system', 'context'] as const).map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: KIND_COLOR[k], display: 'inline-block' }} />
              {t('traj.kind.' + k)}
            </span>
          ))}
        </div>
      </div>

      <div
        className="traj-ledger"
        ref={ledgerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {hasMore && (
          <div className="load-older">
            <button className="btn sm" disabled={loading} onClick={onLoadOlder}>
              {loading ? t('common.loading') : t('chat.loadOlder')}
            </button>
          </div>
        )}
        {turns.map((turn) => {
          const dur = turn.endTime && turn.startTime ? turn.endTime - turn.startTime : undefined;
          const totals = turn.rows.reduce(
            (acc, r) => {
              if (r.usage) {
                acc.in += r.usage.inputTokens || 0;
                acc.out += r.usage.outputTokens || 0;
              }
              if (r.kind === 'tool') acc.tools += 1;
              if (r.error) acc.errors += 1;
              return acc;
            },
            { in: 0, out: 0, tools: 0, errors: 0 },
          );
          return (
            <div key={turn.index} className="traj-turn">
              <div
                className="traj-turn-head"
                onClick={() => setZoomTurn(zoomTurn === turn.index ? null : turn.index)}
                title={zoomTurn === turn.index ? t('traj.zoomOut') : t('traj.zoomIn')}
              >
                {turn.index > 0 ? (locale === 'zh' ? `轮次 ${turn.index}` : `Turn ${turn.index}`) : t('traj.preamble')}
                <span className="dot-sep">·</span> {clockOf(turn.startTime)}
                {dur !== undefined && (<><span className="dot-sep">·</span> {fmtMs(dur)}</>)}
                {turn.model && (<><span className="dot-sep">·</span> {turn.model}</>)}
                {totals.in + totals.out > 0 && (
                  <span className="traj-tok"> in {fmtTok(totals.in)} / out {fmtTok(totals.out)}</span>
                )}
                {totals.tools > 0 && <span className="traj-tok"> · {totals.tools} tool</span>}
                {zoomTurn === turn.index && <Icon name="x" size={11} style={{ marginLeft: 6, opacity: 0.6 }} />}
              </div>
              {turn.rows.map((row) => {
                const isSel = selected === row.seq;
                const icon =
                  row.kind === 'user' ? 'user' :
                  row.kind === 'assistant' ? 'bot' :
                  row.kind === 'tool' ? 'wrench' :
                  row.kind === 'turn-end' ? 'alert' : 'info';
                return (
                  <div key={row.seq} data-traj-seq={row.seq}>
                    <div
                      className={`traj-row ${isSel ? 'sel' : ''} k-${row.kind}`}
                      onClick={() => setSelected(isSel ? null : row.seq)}
                    >
                      <span className="traj-step">{row.step || ''}</span>
                      <Icon name={icon} size={12} />
                      <span className="traj-title">
                        {row.title}
                        {row.sub && <span className="traj-sub"> {row.sub}</span>}
                      </span>
                      <span className="traj-right">
                        {row.pending && props.streaming && <span className="traj-live" />}
                        <span className="traj-time">{clockOf(row.time).slice(0, 8)}</span>
                        <span className={`traj-dur ${row.pending ? 'pend' : row.error ? 'err' : ''}`}>
                          {row.pending ? '…' : fmtMs(row.endTime !== undefined && row.kind !== 'user' ? row.endTime - row.time : undefined)}
                        </span>
                      </span>
                    </div>
                    {isSel && (
                      <div className="traj-detail">
                        <div><b>{t('traj.at')}</b> {new Date(row.time).toLocaleString()} {row.endTime !== undefined && row.kind !== 'user' && (<><b>{t('traj.dur')}</b> {fmtMs(row.endTime - row.time)}</>)}</div>
                        {row.usage && (
                          <div>
                            <b>{t('traj.tokens')}</b> in {row.usage.inputTokens || 0} · out {row.usage.outputTokens || 0}
                            {row.usage.cacheReadTokens ? ` · cache ${row.usage.cacheReadTokens}` : ''}
                            {row.usage.reasoningTokens ? ` · reasoning ${row.usage.reasoningTokens}` : ''}
                          </div>
                        )}
                        {row.args && (
                          <div className="traj-pre">{row.args.length >= 1200 ? row.args + '…' : row.args}</div>
                        )}
                        {row.resultPreview && <div className="traj-pre ok">{row.resultPreview}</div>}
                        {row.error && <div className="traj-pre err">{row.error}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!turns.length && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>{t('traj.empty')}</div>
        )}
      </div>
    </div>
  );
}
