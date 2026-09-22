import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useI18n, relTime } from '../i18n';
import { fe } from '../api';
import { Icon, DeepSeekWhale } from './Icon';
import type { SessionSummary, WorkspaceView } from '../types';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;

function initialWidth(): number {
  const saved = Number(localStorage.getItem('g4d_sidebar_width'));
  if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved;
  return 256;
}

function sessionTitle(s: SessionSummary, projValues: Record<string, { value: any }>, locale: string): string {
  const fromProj = projValues?.title?.value;
  if (typeof fromProj === 'string' && fromProj.trim()) return fromProj;
  const fromList = s.projections?.values?.title;
  if (typeof fromList === 'string' && fromList.trim()) return fromList;
  if (s.blank) return locale === 'zh' ? '新任务' : 'New task';
  if (s.cwd) {
    const base = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base) return base;
  }
  return locale === 'zh' ? '未命名任务' : 'Untitled';
}

export function Sidebar() {
  const { t, locale } = useI18n();
  const st = useStore();
  const [searchText, setSearchText] = useState('');
  const [width, setWidth] = useState(initialWidth);
  // null = user never toggled any folder -> desktop defaults to collapsed, mobile to expanded
  const [collapsedWs, setCollapsedWs] = useState<Record<string, boolean> | null>(() => {
    const raw = localStorage.getItem('g4d_ws_collapsed');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
  const mobileDefaultExpanded = window.matchMedia('(max-width: 768px)').matches;
  const sidebarRef = useRef<HTMLElement>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const isWsCollapsed = (id: string): boolean => {
    if (collapsedWs === null) return !mobileDefaultExpanded;
    return !!collapsedWs[id];
  };

  const toggleWs = (id: string) => {
    setCollapsedWs((prev) => {
      // seed with every known workspace so toggling one never opens the others
      const base: Record<string, boolean> = {};
      for (const w of workspaces) base[w.workspaceId] = prev === null ? !mobileDefaultExpanded : !!prev[w.workspaceId];
      base[id] = !(prev === null ? !mobileDefaultExpanded : !!prev[id]);
      localStorage.setItem('g4d_ws_collapsed', JSON.stringify(base));
      return base;
    });
  };

  // drag-to-resize the sidebar width
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarRef.current?.getBoundingClientRect().width ?? width;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
      setWidth(w);
      localStorage.setItem('g4d_sidebar_width', String(Math.round(w)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const w = sidebarRef.current?.getBoundingClientRect().width;
      if (w) localStorage.setItem('g4d_sidebar_width', String(Math.round(w)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const { sessions, workspaces, archived, taskMeta, activeId, view, sidebarOpen, wsStatus, dshStatus, chats } = st;

  // hide blank placeholder sessions and subagent children
  const visible = useMemo(
    () => sessions.filter((s) => s.origin !== 'subagent' && !archived.includes(s.sessionId) && !s.blank),
    [sessions, archived],
  );

  const filtered = useMemo(() => {
    if (!searchText.trim()) return visible;
    const q = searchText.trim().toLowerCase();
    return visible.filter((s) => {
      const title = sessionTitle(s, chats[s.sessionId]?.projValues || {}, locale).toLowerCase();
      return title.includes(q) || (s.cwd || '').toLowerCase().includes(q);
    });
  }, [visible, searchText, chats, locale]);

  // group by workspace (project), preserving workspace order; leftovers are ungrouped
  const byWorkspace = useMemo(() => {
    const map = new Map<string, { ws: WorkspaceView; items: SessionSummary[] }>();
    for (const ws of workspaces) map.set(ws.workspaceId, { ws, items: [] });
    for (const s of filtered) {
      const ws = workspaces.find((w) => w.sessionIds.includes(s.sessionId));
      if (ws && map.has(ws.workspaceId)) map.get(ws.workspaceId)!.items.push(s);
    }
    const groups = [...map.values()].filter((g) => g.items.length > 0 || !searchText);
    const ungrouped = filtered.filter((s) => !workspaces.some((w) => w.sessionIds.includes(s.sessionId)));
    return { groups, ungrouped };
  }, [filtered, workspaces]);

  const pinned = filtered.filter((s) => taskMeta[s.sessionId]?.pinned);

  const anyWsCollapsed = byWorkspace.groups.some((g) => isWsCollapsed(g.ws.workspaceId));
  const toggleAllWs = () => {
    const next: Record<string, boolean> = {};
    for (const g of byWorkspace.groups) next[g.ws.workspaceId] = !anyWsCollapsed; // some collapsed -> expand all
    setCollapsedWs(next);
    localStorage.setItem('g4d_ws_collapsed', JSON.stringify(next));
  };

  // archived tasks: hidden from the main list, recoverable from the bottom section
  const archivedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.origin !== 'subagent' && !s.blank && archived.includes(s.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, archived],
  );

  const restore = async (sid: string) => {
    setRestoringId(sid);
    try {
      await fe.restoreArchived(sid);
      await Promise.all([st.refreshSessions(), st.refreshWorkspaces()]);
      st.toast('success', t('task.restored'));
    } catch (e: any) {
      st.toast('error', e?.status === 409 ? t('task.restoreBusy') : e?.message || 'restore failed');
    } finally {
      setRestoringId(null);
    }
  };
  // recent conversations: newest 5 regardless of folder (quick access, storage untouched)
  const recent = useMemo(
    () =>
      [...filtered]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [filtered],
  );

  const dshDot = dshStatus === 'up' || dshStatus === 'external' ? 'ok' : dshStatus === 'down' ? 'bad' : 'warn';
  const wsDot = wsStatus === 'connected' ? 'ok' : 'warn';

  const renderTask = (s: SessionSummary, pinnedRow = false) => {
    const chat = chats[s.sessionId];
    const title = sessionTitle(s, chat?.projValues || {}, locale);
    const isActive = activeId === s.sessionId;
    const running = s.running || !!chat?.streaming;
    const pinnedNow = !!taskMeta[s.sessionId]?.pinned;
    return (
      <div
        key={s.sessionId}
        className={`task-row ${isActive ? 'active' : ''} ${pinnedRow ? 'pinned-row' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => void st.openSession(s.sessionId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void st.openSession(s.sessionId);
        }}
      >
        <span className={`t-dot ${running ? 'running' : ''}`} />
        <div className="t-body">
          <div className="t-title" style={{ opacity: s.blank ? 0.55 : 1 }}>{title}</div>
          <div className="t-sub">
            {running ? `${t('task.running')} · ` : ''}{relTime(s.updatedAt, locale)}
          </div>
        </div>
        <div className="t-menu" onClick={(e) => e.stopPropagation()}>
          <button title={pinnedNow ? t('task.unpin') : t('task.pin')} onClick={() => void st.setPinned(s.sessionId, !pinnedNow)}>
            <Icon name="pin" size={13} />
          </button>
          <button
            title={t('task.rename')}
            onClick={() => {
              const name = window.prompt(t('task.rename'), title);
              if (name && name.trim()) void st.rename(s.sessionId, name.trim());
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
          <button title={t('task.fork')} onClick={() => void st.fork(s.sessionId)}>
            <Icon name="fork" size={13} />
          </button>
          <button title={t('task.archive')} onClick={() => void st.archive(s.sessionId)}>
            <Icon name="archive" size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${sidebarOpen ? 'open' : ''}`}
      style={{ width }}
    >
      <div className="sidebar-resizer" onMouseDown={startResize} title="" />
      <div className="brand">
        <div className="brand-logo">
          <DeepSeekWhale size={24} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name">gui4dsh</div>
          <div className="brand-sub">{t('app.tagline')}</div>
        </div>
      </div>

      <button className="new-task-btn" onClick={() => st.setNewTaskModal(true)}>
        <Icon name="plus" size={15} /> {t('nav.newTask')}
      </button>

      <div className="search-box">
        <Icon name="search" size={13} className="s-icon" />
        <input
          placeholder={t('sidebar.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && searchText.trim()) st.setView('search');
          }}
        />
      </div>

      <nav className="nav">
        <NavBtn icon="chat" label={t('nav.tasks')} active={view === 'chat'} onClick={() => st.setView('chat')} />
        <NavBtn icon="clock" label={t('nav.automations')} active={view === 'automations'} onClick={() => st.setView('automations')} />
        <NavBtn icon="command" label={t('nav.skills')} active={view === 'skills'} onClick={() => st.setView('skills')} />
        <NavBtn icon="folder" label={t('nav.projects')} active={view === 'projects'} onClick={() => st.setView('projects')} />
        <NavBtn icon="brain" label={t('nav.memory')} active={view === 'memory'} onClick={() => st.setView('memory')} />
      </nav>

      <div className="task-scroll">
        {recent.length > 0 && (
          <>
            <div className="task-section-title">
              <Icon name="activity" size={12} /> {t('sidebar.recent')}
            </div>
            {recent.map((s) => renderTask(s))}
          </>
        )}
        {pinned.length > 0 && (
          <>
            <div className="task-section-title">
              <Icon name="pin" size={11} /> {t('sidebar.pinned')}
            </div>
            {pinned.map((s) => renderTask(s, true))}
          </>
        )}

        {byWorkspace.groups.some((g) => g.items.length > 0) && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 10px 4px' }}>
            <button className="btn sm" onClick={toggleAllWs} style={{ padding: '3px 9px', fontSize: 11.5 }}>
              <Icon name={anyWsCollapsed ? 'chevronDown' : 'chevronRight'} size={11} />
              {anyWsCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')}
            </button>
          </div>
        )}

        {byWorkspace.groups.map(({ ws, items }) => {
          const isCollapsed = isWsCollapsed(ws.workspaceId);
          return (
            <div key={ws.workspaceId}>
              <div
                className="task-section-title"
                style={{ cursor: 'pointer' }}
                title={ws.path}
                onClick={() => toggleWs(ws.workspaceId)}
              >
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                <Icon name="folder" size={12} />
                {ws.title}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}>{items.length}</span>
              </div>
              {!isCollapsed && items.map((s) => renderTask(s))}
            </div>
          );
        })}

        {byWorkspace.ungrouped.length > 0 && (
          <div>
            <div className="task-section-title">
              <Icon name="file" size={11} /> {t('sidebar.ungrouped')}
            </div>
            {byWorkspace.ungrouped.map((s) => renderTask(s))}
          </div>
        )}

        {archivedSessions.length > 0 && (
          <div style={{ marginTop: 10, opacity: 0.85 }}>
            <div className="task-section-title" style={{ cursor: 'pointer' }} onClick={() => setArchivedOpen(!archivedOpen)}>
              <Icon name={archivedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <Icon name="archive" size={11} /> {t('sidebar.archived')}
              <span style={{ color: 'var(--faint)', fontWeight: 400 }}>{archivedSessions.length}</span>
            </div>
            {archivedOpen && archivedSessions.map((s) => {
              const title = sessionTitle(s, chats[s.sessionId]?.projValues || {}, locale);
              const restoring = restoringId === s.sessionId;
              return (
                <div key={s.sessionId} className={`task-row ${activeId === s.sessionId ? 'active' : ''}`} onClick={() => void st.openSession(s.sessionId)}>
                  <span className="t-dot" style={{ background: 'var(--faint)' }} />
                  <div className="t-body">
                    <div className="t-title" style={{ opacity: 0.65 }}>{title}</div>
                    <div className="t-sub">{relTime(s.updatedAt, locale)}</div>
                  </div>
                  <div className="t-menu" onClick={(e) => e.stopPropagation()} style={{ display: 'flex' }}>
                    <button
                      title={t('task.restore')}
                      disabled={restoring}
                      style={{ border: 'none', background: 'transparent', color: 'var(--dim)', cursor: 'pointer', width: 22, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={() => void restore(s.sessionId)}
                    >
                      <Icon name={restoring ? 'clock' : 'refresh'} size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {filtered.length === 0 && (
          <div style={{ padding: '20px 10px', color: 'var(--faint)', fontSize: 12.5 }}>{t('sidebar.noTasks')}</div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="status-line">
          <span className={`dot ${dshDot}`} />
          <span>{t(`dsh.${dshStatus}`)}</span>
          <span style={{ margin: '0 2px' }}>·</span>
          <span className={`dot ${wsDot}`} />
          <span>{t(`conn.${wsStatus === 'connected' ? 'connected' : wsStatus === 'connecting' ? 'connecting' : 'lost'}`)}</span>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" title={t('nav.remote')} onClick={() => st.setRemoteOpen(true)}>
            <Icon name="phone" size={16} />
          </button>
          <button
            className={`icon-btn ${view === 'settings' ? 'active' : ''}`}
            title={t('nav.settings')}
            onClick={() => st.setView('settings')}
          >
            <Icon name="gear" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavBtn({ icon, label, active, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={15} className="n-icon" />
      <span>{label}</span>
    </button>
  );
}
