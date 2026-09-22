import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, type AttachmentDraft } from '../store';
import { useI18n, relTime } from '../i18n';
import { dshCall } from '../api';
import { AssistantMessageView, ContextRow, StreamingView, ToolCard, UserBubble } from './blocks';
import { TrajectoryView } from './TrajectoryView';
import { FileSidebar } from './FileSidebar';
import { deriveDeliverables } from '../store';
import { Icon } from './Icon';

export function ChatView() {
  const { t, locale } = useI18n();
  const st = useStore();
  const activeId = useStore((s) => s.activeId);
  const chat = useStore((s) => (s.activeId ? s.chats[s.activeId] : undefined));
  const session = useStore((s) => s.sessions.find((x) => x.sessionId === s.activeId));
  const models = useStore((s) => (s.activeId ? s.modelsCache[s.activeId] : undefined));
  const workspaces = useStore((s) => s.workspaces);
  const jobs = useStore((s) => (s.activeId ? s.jobs[s.activeId] : undefined));
  const schedRaw = useStore((s) => (s.activeId ? s.chats[s.activeId]?.projValues?.schedule?.value : undefined));
  const schedules: any[] = Array.isArray(schedRaw) ? schedRaw : [];
  const goal = useStore((s) => {
    const sid = s.activeId;
    const g = sid ? s.chats[sid]?.projValues?.goal?.value : null;
    return g && g.goal ? g : null;
  });
  const runningJobs = (jobs || []).filter((j) => !j.finishedAt).length;
  const deliverables = useMemo(() => deriveDeliverables(chat?.traj || []), [chat?.traj]);
  // last assistant item per turn number (reverse first-wins)
  const turnFinalSeq = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = (chat?.items.length || 0) - 1; i >= 0; i--) {
      const it = chat!.items[i];
      if (it.kind === 'assistant' && typeof it.turn === 'number' && !m.has(it.turn)) m.set(it.turn, it.seq);
    }
    return m;
  }, [chat?.items]);

  const [input, setInput] = useState('');
  const [showReasoning, setShowReasoning] = useState(true);
  const [showTraj, setShowTraj] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobTick, setJobTick] = useState(0);
  const [schedOpen, setSchedOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<any>(null);
  const SpeechRec = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;

  const toggleMic = () => {
    if (!SpeechRec) return;
    if (recRef.current) {
      try { recRef.current.stop(); } catch { /* ignore */ }
      return;
    }
    const r = new SpeechRec();
    r.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
    r.interimResults = true;
    r.continuous = true;
    const base = input ? input.trimEnd() + ' ' : '';
    let finalText = '';
    r.onresult = (ev: any) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const tr = ev.results[i][0]?.transcript || '';
        if (ev.results[i].isFinal) finalText += tr;
        else interim += tr;
      }
      setInput(base + finalText + interim);
    };
    r.onend = () => { recRef.current = null; setRecording(false); };
    r.onerror = r.onend;
    recRef.current = r;
    try { r.start(); setRecording(true); } catch { recRef.current = null; }
  };

  useEffect(() => {
    if (!jobsOpen) return;
    const t = setInterval(() => setJobTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [jobsOpen]);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [permMode, setPermMode] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickBottom = useRef(true);
  const itemsLength = chat?.items.length || 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [itemsLength, chat?.items[chat.items.length - 1]?.parts?.length, activeId]);

  useEffect(() => {
    stickBottom.current = true;
  }, [activeId]);

  // composer preset (from skills view invoke)
  useEffect(() => {
    if (st.composerPreset) {
      setInput(st.composerPreset);
      st.setComposerPreset('');
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.composerPreset]);

  // load current dsh permission preset
  useEffect(() => {
    if (!activeId) return;
    dshCall<{ namespaces: Array<{ ns: string; value?: { defaultPreset?: string } }> }>('settings.describe', {}).then((r) => {
      if (r.ok) {
        const ns = r.value?.namespaces?.find((n) => n.ns === 'permission');
        setPermMode(ns?.value?.defaultPreset || 'workspace-write');
      }
    });
  }, [activeId]);

  const switchPerm = async (preset: 'workspace-write' | 'danger-full-access') => {
    setPermOpen(false);
    const r = await dshCall('settings.update', { ns: 'permission', patch: { defaultPreset: preset } });
    if (r.ok) {
      setPermMode(preset);
      st.toast('success', t('chat.permChanged'), t('chat.permHint'));
    } else {
      st.toast('error', r.error?.message || 'failed');
    }
  };

  const slashQuery = input.startsWith('/') && !input.includes('\n') ? input.slice(1).split(' ')[0].toLowerCase() : null;
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : st.skills.filter((s) => s.name.toLowerCase().includes(slashQuery)).slice(0, 8)),
    [slashQuery, st.skills],
  );

  // @-reference trigger: browse workspaceFiles listings, insert dsh's `@path` grammar
  const atToken = useMemo(() => {
    const m = /(^|\s)@([^@\n]*)$/.exec(input);
    return m ? m[2] : null;
  }, [input]);
  const atDir = atToken !== null ? atToken.slice(0, atToken.lastIndexOf('/') + 1) : '';
  const atFilter = atToken !== null ? atToken.slice(atToken.lastIndexOf('/') + 1).toLowerCase() : '';
  const atCandidates = useMemo(() => {
    if (atToken === null) return [];
    const entries = st.fileListings[atDir];
    if (!entries) return [];
    return entries
      .filter((e) => e.name.toLowerCase().includes(atFilter))
      .slice(0, 8);
  }, [atToken, atDir, atFilter, st.fileListings]);
  useEffect(() => {
    if (atToken !== null && activeId && st.fileListings[atDir] === undefined) void st.listFiles(activeId, atDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atToken, atDir]);
  const applyAt = (entry: { name: string; type: string }) => {
    const isDir = entry.type === 'directory';
    const rel = atDir + entry.name + (isDir ? '/' : '');
    const quoted = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
    setInput((prev) => prev.replace(/(^|\s)@([^@\n]*)$/, (_m, pre) => pre + quoted + (isDir ? '' : ' ')));
    taRef.current?.focus();
  };

  if (!activeId || !session) {
    return (
      <div className="chat">
        <div className="chat-head">
          <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
          <span style={{ fontWeight: 700 }}>{t('nav.tasks')}</span>
        </div>
        <div className="chat-scroll">
          <div className="chat-empty">
            <div className="big"><Icon name="message" size={44} /></div>
            <div>{t('chat.noSession')}</div>
            <button className="btn primary" onClick={() => st.setNewTaskModal(true)}>{t('nav.newTask')}</button>
          </div>
        </div>
      </div>
    );
  }

  const title =
    (typeof chat?.projValues.title?.value === 'string' && chat.projValues.title.value) ||
    (typeof session.projections?.values?.title === 'string' && (session.projections.values.title as string)) ||
    (session.blank ? t('task.new') : t('task.untitled'));

  const ws = workspaces.find((w) => w.sessionIds.includes(activeId));
  const cwd = session.cwd || ws?.path || '';
  const running = session.running || !!chat?.streaming;

  const doSend = () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    setInput('');
    setAttachments([]);
    stickBottom.current = true;
    void st.sendMessage(activeId, text, 'queue', attachments.length ? attachments : undefined);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: AttachmentDraft[] = [];
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/') && f.size < 8 * 1024 * 1024) {
        const dataUrl = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.readAsDataURL(f);
        });
        next.push({ name: f.name, size: f.size, kind: 'image', mediaType: f.type, dataBase64: dataUrl.split(',')[1] });
      } else {
        next.push({ name: f.name, size: f.size, kind: 'file', bytes: await f.arrayBuffer() });
      }
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const applySlash = (name: string) => {
    setInput(`/${name} `);
    taRef.current?.focus();
  };

  const currentModel = models?.current || chat?.model || { provider: '—', model: '—' };
  const currentModelDef = (() => {
    for (const g of models?.groups || []) {
      if (g.id !== currentModel.provider) continue;
      for (const m of g.models) if (m.id === currentModel.model) return m as any;
    }
    return null;
  })();
  const currentModelName = currentModelDef?.name || currentModel.model;
  const currentEfforts: Array<{ id: string; name: string; description?: string }> | null = currentModelDef?.reasoning?.efforts || null;
  const currentEffortId = (currentModel as any).reasoningEffort || currentModelDef?.reasoning?.defaultEffort || '';
  const effortLabel = (id: string) => {
    if (locale === 'zh') {
      const zh: Record<string, string> = { off: t('chat.effortOff'), low: t('chat.effortLow'), medium: t('chat.effortMedium'), high: t('chat.effortHigh'), max: t('chat.effortMax') };
      return zh[id] || id;
    }
    return id.charAt(0).toUpperCase() + id.slice(1);
  };
  const goalPhaseLabel = (phase?: string) => {
    const map: Record<string, string> = locale === 'zh'
      ? { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' }
      : { active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete' };
    return map[phase || 'active'] || phase || '';
  };
  const jobElapsed = (j: { startedAt: number; finishedAt?: number }) => {
    void jobTick;
    const ms = (j.finishedAt ?? Date.now()) - j.startedAt;
    if (ms < 60_000) return Math.max(0, Math.round(ms / 1000)) + 's';
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <div
          className="chat-title"
          title={t('task.rename')}
          onClick={() => {
            const name = window.prompt(t('task.rename'), title);
            if (name && name.trim()) void st.rename(activeId, name.trim());
          }}
        >
          {title}
        </div>
        <div className="chat-meta hide-sm">
          {ws ? <><Icon name="folder" size={12} /> {ws.title}</> : cwd ? <><Icon name="folder" size={12} /> {cwd}</> : ''}{' '}
          {session.agentPreset ? `· ${session.agentPreset}` : ''}
        </div>
        <div style={{ flex: 1 }} />
        <button
          className={`btn sm ${st.filePanel ? 'primary' : ''}`}
          title={t('files.title')}
          onClick={() => st.toggleFilePanel()}
        >
          <Icon name="folder" size={13} />
        </button>
        {schedules.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button className="btn sm" title={t('sched.title')} onClick={() => setSchedOpen(!schedOpen)}>
              <Icon name="timer" size={12} />
              <span className="jobs-badge">{schedules.length}</span>
            </button>
            {schedOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setSchedOpen(false)} />
                <div className="jobs-pop">
                  <div className="jobs-pop-head">{t('sched.title')}</div>
                  {schedules.map((r: any) => (
                    <div key={r.id} className="jobs-row">
                      <span className="jobs-kind">{r.kind}</span>
                      <span className="jobs-label" title={r.prompt}>{r.prompt}</span>
                      <span className="jobs-elapsed">
                        {r.kind === 'every'
                          ? `${Math.max(1, Math.round((r.everySeconds || 0) / 60))}${locale === 'zh' ? '分/次' : 'm'}`
                          : new Date(r.scheduledAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {jobs && jobs.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              className="btn sm"
              title={t('jobs.title')}
              onClick={() => setJobsOpen(!jobsOpen)}
            >
              <Icon name="play" size={12} />
              {runningJobs > 0 && <span className="jobs-badge">{runningJobs}</span>}
            </button>
            {jobsOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setJobsOpen(false)} />
                <div className="jobs-pop">
                  <div className="jobs-pop-head">{t('jobs.title')}</div>
                  {[...jobs]
                    .sort((a, b) => (a.finishedAt ? 1 : 0) - (b.finishedAt ? 1 : 0) || a.startedAt - b.startedAt)
                    .map((j) => (
                      <div key={j.id} className={`jobs-row ${j.finishedAt ? 'done' : 'run'}`}>
                        <span className={`jobs-dot ${j.finishedAt ? (j.status === 'failed' ? 'err' : 'ok') : 'live'}`} />
                        <span className="jobs-kind">{j.kind}</span>
                        <span className="jobs-label" title={j.label}>{j.label}</span>
                        {j.detail && <span className="jobs-detail">{j.detail}</span>}
                        <span className="jobs-elapsed">{jobElapsed(j)}</span>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>
        )}
        <button
          className={`btn sm ${showTraj ? 'primary' : ''}`}
          onClick={() => setShowTraj(!showTraj)}
          title={t('traj.title')}
        >
          <Icon name="activity" size={13} />
        </button>
        <button
          className={`btn sm ${showReasoning ? 'primary' : ''}`}
          onClick={() => setShowReasoning(!showReasoning)}
          title={t('chat.reasoning')}
        >
          <Icon name="brain" size={13} />
        </button>
      </div>

      <div className="chat-body-row">
      <div className="chat-main">
      {showTraj ? (
        <div className="chat-scroll traj-host">
          <TrajectoryView
            traj={chat?.traj || []}
            streaming={!!chat?.streaming}
            hasMore={!!chat?.hasMore}
            loading={!!chat?.loading}
            onLoadOlder={() => activeId && void st.loadOlder(activeId)}
          />
        </div>
      ) : (
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {chat?.hasMore && (
          <div className="load-older">
            <button className="btn sm" disabled={chat.loading} onClick={() => void st.loadOlder(activeId)}>
              {chat.loading ? t('common.loading') : t('chat.loadOlder')}
            </button>
          </div>
        )}

        {chat?.todos && chat.todos.length > 0 && (
          <details className="todo-panel" open>
            <summary>
              <Icon name="list" size={13} />
              {locale === 'zh' ? `任务清单 (${chat.todos.filter((x) => x.status === 'completed').length}/${chat.todos.length})` : `Todos (${chat.todos.filter((x) => x.status === 'completed').length}/${chat.todos.length})`}
            </summary>
            <div className="todo-list">
              {chat.todos.map((td: any, i: number) => (
                <div key={i} className={`todo-item ${td.status === 'completed' ? 'done' : ''} ${td.status === 'in_progress' ? 'active' : ''}`}>
                  <span className="chk" />
                  <span className="txt">{td.content}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {chat?.items.map((item, i) => {
          if (item.kind === 'user') {
            return (
              <div className="msg" key={`${item.seq}-${i}`}>
                <div className="msg-role">
                  <Icon name="user" size={12} /> {locale === 'zh' ? '你' : 'You'}
                  {item.optimistic && <span style={{ color: 'var(--faint)', fontWeight: 400 }}>…</span>}
                </div>
                <UserBubble item={item} sessionId={activeId} />
              </div>
            );
          }
          if (item.kind === 'assistant') {
            if (item.streaming) {
              return (
                <div className="msg" key={`s-${item.seq}-${i}`}>
                  <div className="msg-role"><Icon name="bot" size={12} /> dsh</div>
                  <StreamingView item={item} showReasoning={showReasoning} />
                </div>
              );
            }
            const src = item.message?.source || {};
            const curRating = chat?.feedback[(item as any).message?.id]?.rating;
            const turnFiles = typeof item.turn === 'number' && turnFinalSeq.get(item.turn) === item.seq
              ? deliverables.get(item.turn)
              : undefined;
            return (
              <div className="msg" key={`${item.seq}-${i}`}>
                <div className="msg-role">
                  <Icon name="bot" size={12} /> dsh{' '}
                  <span style={{ color: 'var(--faint)', fontWeight: 400 }}>{src.provider}/{src.model}</span>
                </div>
                <AssistantMessageView item={item} showReasoning={showReasoning} />
                <div className="msg-foot">
                  {item.usage && (
                    <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                      in {fmtK(item.usage.inputTokens || 0)} · out {fmtK(item.usage.outputTokens || 0)}
                      {item.usage.cacheReadTokens ? ` · cache ${fmtK(item.usage.cacheReadTokens)}` : ''}
                    </span>
                  )}
                  {(item as any).message?.id && (
                    <span className="rate-strip">
                      <button
                        className={`rate-btn ${curRating === 'positive' ? 'pos' : ''}`}
                        title={t('fb.pos')}
                        onClick={() => void st.rate(activeId, (item as any).message.id, 'positive')}
                      >
                        <Icon name="thumbUp" size={13} />
                      </button>
                      <button
                        className={`rate-btn ${curRating === 'negative' ? 'neg' : ''}`}
                        title={t('fb.neg')}
                        onClick={() => void st.rate(activeId, (item as any).message.id, 'negative')}
                      >
                        <Icon name="thumbDown" size={13} />
                      </button>
                    </span>
                  )}
                </div>
                {turnFiles && turnFiles.length > 0 && (
                  <div className="deliver-row">
                    <span className="d-label">{t('deliver.label')}</span>
                    {turnFiles.map((f) => (
                      <button
                        key={f.path}
                        className="d-chip"
                        title={f.path}
                        onClick={() => {
                          void navigator.clipboard?.writeText(f.path);
                          st.toast('success', locale === 'zh' ? '路径已复制' : 'Path copied', f.path);
                        }}
                      >
                        <Icon name="file" size={11} />
                        <span className="d-name">{f.path.split(/[\\/]/).pop()}</span>
                        <span className="d-op">{f.op}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === 'tool') {
            return <ToolCard key={`${item.seq}-${i}`} item={item} />;
          }
          if (item.kind === 'context') {
            return <ContextRow key={`${item.seq}-${i}`} item={item} />;
          }
          return (
            <div className={`notice-row ${item.level}`} key={`${item.seq}-${i}`}>
              <Icon name={item.level === 'error' ? 'alert' : 'info'} size={13} />
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{noticeText(item, locale)}</span>
            </div>
          );
        })}

        {chat?.queue && chat.queue.filter((q: any) => q.placement !== 'context').length > 0 && (
          <div className="queue-dock">
            <div style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="clock" size={11} /> {t('chat.queue')}
            </div>
            {chat.queue
              .filter((q: any) => q.placement !== 'context')
              .map((q: any) => {
                const text = (q.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
                return (
                  <div className="queue-item" key={q.id}>
                    <Icon name={q.placement === 'steering' ? 'zap' : 'clock'} size={12} />
                    <span className="q-text">{text}</span>
                    <button className="btn sm" onClick={() => {
                      const next = window.prompt(t('chat.queueEdit'), text);
                      if (next !== null && next.trim()) void st.queueAction(activeId, q.id, { kind: 'edit', content: [{ type: 'text', text: next }] });
                    }}>{t('chat.queueEdit')}</button>
                    <button className="btn sm" onClick={() => void st.queueAction(activeId, q.id, { kind: 'remove' })}>
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>
      )}

      <div className="composer-wrap">
        {goal && (
          <div className={`goal-bar ph-${goal.goal?.phase || 'active'}`}>
            <Icon name="flag" size={12} />
            <span className="g-obj">{goal.goal?.objective}</span>
            <span className="g-phase">{goalPhaseLabel(goal.goal?.phase)}</span>
            {typeof goal.roundsStarted === 'number' && goal.goal?.maxGoalRounds ? (
              <span className="g-rounds">{goal.roundsStarted}/{goal.goal.maxGoalRounds}</span>
            ) : null}
          </div>
        )}
        {slashMatches.length > 0 && (
          <div className="slash-menu">
            {slashMatches.map((s) => (
              <div key={s.name} className="slash-item" onClick={() => applySlash(s.name)}>
                <span className="s-name mono">/{s.name}</span>
                <span className="s-desc">{s.description}</span>
              </div>
            ))}
          </div>
        )}
        {atCandidates.length > 0 && (
          <div className="slash-menu at-menu">
            {atCandidates.map((e) => (
              <div key={e.name} className="slash-item" onClick={() => applyAt(e)}>
                <Icon name={e.type === 'directory' ? 'folder' : 'file'} size={12} />
                <span className="s-name mono">{e.name}</span>
                <span className="s-desc">{e.type === 'directory' ? (locale === 'zh' ? '文件夹' : 'folder') : fmtSize(e.size)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="composer">
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {attachments.map((a, i) => (
                <span key={i} className="att-chip" title={`${a.name} · ${(a.size / 1024).toFixed(0)}KB`}>
                  <Icon name={a.kind === 'image' ? 'eye' : 'file'} size={11} />
                  <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button
                    style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'flex', padding: 0 }}
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            placeholder={t('chat.inputPlaceholder')}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.currentTarget.style.height = 'auto';
              e.currentTarget.style.height = Math.min(180, e.currentTarget.scrollHeight) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                doSend();
              }
            }}
          />
          <div className="composer-foot">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <label
                className="model-chip"
                title={t('chat.attach')}
                style={{ cursor: 'pointer' }}
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="link" size={12} /> {t('chat.attachShort')}
              </label>
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  void pickFiles(e.target.files);
                  e.currentTarget.value = '';
                }}
              />
              <div style={{ position: 'relative' }}>
                <button
                  className="model-chip"
                  title={t('chat.perm')}
                  onClick={() => { setPermOpen(!permOpen); setModelOpen(false); setEffortOpen(false); }}
                  style={permMode === 'danger-full-access' ? { borderColor: 'var(--red)', color: 'var(--red)' } : undefined}
                >
                  <Icon name="shield" size={12} /> {permMode === 'danger-full-access' ? (locale === 'zh' ? '全自动' : 'Auto') : (locale === 'zh' ? '标准' : 'Std')}
                </button>
                {permOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setPermOpen(false)} />
                    <div
                      style={{
                        position: 'absolute', bottom: '110%', left: 0, zIndex: 30, minWidth: 250,
                        background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 10,
                        boxShadow: 'var(--shadow)', overflow: 'hidden',
                      }}
                    >
                      {([
                        { id: 'workspace-write' as const, label: t('chat.permStandard') },
                        { id: 'danger-full-access' as const, label: t('chat.permYolo') },
                      ]).map((opt) => (
                        <div
                          key={opt.id}
                          style={{
                            padding: '9px 12px', cursor: 'pointer', fontSize: 13,
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: permMode === opt.id ? 'var(--accent-soft)' : 'transparent',
                            color: permMode === opt.id ? 'var(--accent)' : 'var(--text)',
                          }}
                          onClick={() => void switchPerm(opt.id)}
                        >
                          <Icon name={opt.id === 'danger-full-access' ? 'alert' : 'shield'} size={13} />
                          {opt.label}
                          {permMode === opt.id && <span style={{ marginLeft: 'auto' }}>✓</span>}
                        </div>
                      ))}
                      <div style={{ padding: '6px 12px 8px', fontSize: 11, color: 'var(--faint)', borderTop: '1px solid var(--border)' }}>
                        {t('chat.permHint')}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <button
                  className="model-chip"
                  title={currentModel.provider + '/' + currentModel.model}
                  onClick={() => { setModelOpen(!modelOpen); setPermOpen(false); setEffortOpen(false); }}
                >
                  <Icon name="sparkles" size={12} /> {currentModelName}
                </button>
                {modelOpen && models && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setModelOpen(false)} />
                    <div
                      style={{
                        position: 'absolute', bottom: '110%', left: 0, zIndex: 30,
                        minWidth: 220, maxWidth: 'min(78vw, 340px)',
                        background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 10,
                        boxShadow: 'var(--shadow)', maxHeight: '46vh', overflowY: 'auto',
                      }}
                    >
                      {models.groups.map((g) => (
                        <div key={g.id}>
                          <div style={{ padding: '8px 12px 2px', fontSize: 11, color: 'var(--faint)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</div>
                          {g.models.map((m) => {
                            const active = models.current.provider === g.id && models.current.model === m.id;
                            return (
                              <div
                                key={m.id}
                                style={{
                                  padding: '7px 12px', cursor: 'pointer', fontSize: 13,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                  background: active ? 'var(--accent-soft)' : 'transparent',
                                  color: active ? 'var(--accent)' : 'var(--text)',
                                }}
                                onClick={() => {
                                  void st.selectModel(activeId, g.id, m.id);
                                  setModelOpen(false);
                                }}
                              >
                                {m.name}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {!models.routable && (
                        <div style={{ padding: 10, fontSize: 12, color: 'var(--red)' }}>{models.failures[0]?.message || 'not routable'}</div>
                      )}
                    </div>
                  </>
                )}
              </div>
              {currentEfforts && currentEfforts.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    className="model-chip"
                    title={t('chat.effort')}
                    onClick={() => { setEffortOpen(!effortOpen); setModelOpen(false); setPermOpen(false); }}
                  >
                    <Icon name="activity" size={12} /> {effortLabel(currentEffortId)}
                  </button>
                  {effortOpen && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setEffortOpen(false)} />
                      <div
                        style={{
                          position: 'absolute', bottom: '110%', right: 0, zIndex: 30,
                          minWidth: 170, maxWidth: 'min(70vw, 300px)',
                          background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 10,
                          boxShadow: 'var(--shadow)', overflow: 'hidden',
                        }}
                      >
                        {currentEfforts.map((e) => {
                          const active = e.id === currentEffortId;
                          return (
                            <div
                              key={e.id}
                              title={e.description || ''}
                              style={{
                                padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                                display: 'flex', alignItems: 'center', gap: 6,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                background: active ? 'var(--accent-soft)' : 'transparent',
                                color: active ? 'var(--accent)' : 'var(--text)',
                              }}
                              onClick={() => {
                                const cur = models?.current;
                                if (!cur) return;
                                void st.selectModel(activeId, cur.provider, cur.model, e.id);
                                setEffortOpen(false);
                              }}
                            >
                              {effortLabel(e.id)}
                              {e.id === currentModelDef?.reasoning?.defaultEffort && !active && (
                                <span style={{ fontSize: 10, color: 'var(--faint)' }}>{locale === 'zh' ? '默认' : 'default'}</span>
                              )}
                              {active && <span style={{ marginLeft: 'auto' }}>✓</span>}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {SpeechRec && (
              <button
                className={`send-btn voice ${recording ? 'rec' : ''}`}
                title={recording ? t('voice.stop') : t('voice.start')}
                onClick={toggleMic}
              >
                <Icon name="mic" size={14} />
              </button>
            )}
            {running ? (
              <button className="send-btn stop" onClick={() => void st.cancel(activeId)}>
                <Icon name="stop" size={14} /> <span className="send-label">{t('chat.stop')}</span>
              </button>
            ) : (
              <button className="send-btn" disabled={!input.trim()} onClick={doSend}>
                <Icon name="send" size={14} /> <span className="send-label">{t('chat.send')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      {st.filePanel && activeId && <FileSidebar sessionId={activeId} />}
      </div>
    </div>
  );
}

function noticeText(item: { text?: string; level?: string }, locale: string): string {
  const map: Record<string, string> = {
    interrupted: locale === 'zh' ? '会话被中断' : 'Turn interrupted',
    'max-tokens': locale === 'zh' ? '达到输出上限' : 'Output limit reached',
  };
  return map[item.text || ''] || item.text || '';
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtSize(n?: number): string {
  if (typeof n !== 'number') return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export { relTime };
