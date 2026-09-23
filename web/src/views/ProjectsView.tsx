import React, { useState } from 'react';
import { dshCall, dshOk } from '../api';
import { useStore } from '../store';
import { useI18n, relTime } from '../i18n';
import { Icon } from '../components/Icon';
import type { WorkspaceView as WS } from '../types';

function projSessionTitle(s: { sessionId: string; cwd?: string; projections?: { values?: Record<string, unknown> } }, locale: string): string {
  const t = s.projections?.values?.title;
  if (typeof t === 'string' && t.trim()) return t;
  if (s.cwd) {
    const base = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base) return base;
  }
  return locale === 'zh' ? '未命名任务' : 'Untitled';
}

export function ProjectsView() {
  const { t, locale } = useI18n();
  const st = useStore();
  const workspaces = useStore((s) => s.workspaces);
  const sessions = useStore((s) => s.sessions);
  const archived = useStore((s) => s.archived);
  const chats = useStore((s) => s.chats);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('g4d_proj_collapsed') || '{}');
    } catch {
      return {};
    }
  });

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem('g4d_proj_collapsed', JSON.stringify(next));
      return next;
    });
  };

  const addProject = async (dir?: string) => {
    const p = (dir ?? path).trim();
    if (!p) return;
    setBusy(true);
    const res = await dshCall<{ workspace: WS; created: boolean }>('workspace.create', { path: p });
    setBusy(false);
    if (!res.ok) {
      st.toast('error', res.error?.message || t('projects.invalidPath'), res.error?.code);
      return;
    }
    if (!res.value!.created) st.toast('info', t('projects.exists'));
    setPath('');
    await st.refreshWorkspaces();
  };

  const pickDirectory = async () => {
    const res = await dshCall<{ path: string | null }>('host.pickDirectory', {});
    if (res.ok && res.value?.path) await addProject(res.value.path);
  };

  return (
    <>
      <div className="topbar">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <h1><Icon name="folder" size={15} /> {t('projects.title')}</h1>
        <div style={{ flex: 1 }} />
      </div>
      <div className="view-body">
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('projects.path')}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addProject()}
          />
          <button className="btn" onClick={() => void pickDirectory()}><Icon name="folderPlus" size={14} /> {t('projects.browse')}</button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={() => void addProject()}>
            <Icon name="plus" size={14} /> {t('projects.add')}
          </button>
        </div>

        {workspaces.length === 0 && (
          <div style={{ color: 'var(--faint)', padding: '24px 0', textAlign: 'center' }}>{t('projects.noProjects')}</div>
        )}

        <div className="proj-grid">
          {workspaces.map((w) => {
            const wsSessions = sessions.filter(
              (s) =>
                w.sessionIds.includes(s.sessionId) &&
                s.origin !== 'subagent' &&
                !archived.includes(s.sessionId) &&
                !s.blank,
            );
            const runningCount = wsSessions.filter((s) => s.running).length;
            return (
              <div key={w.workspaceId} className="card proj-card hover">
                <div
                  className="p-head"
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleCollapse(w.workspaceId)}
                  onKeyDown={(e) => e.key === 'Enter' && toggleCollapse(w.workspaceId)}
                >
                  <Icon name={collapsed[w.workspaceId] ? 'chevronRight' : 'chevronDown'} size={13} />
                  <Icon name="folder" size={16} />
                  <span className="p-title">{w.title}</span>
                  <span className="badge">{wsSessions.length} {t('nav.tasks')}</span>
                  {runningCount > 0 && <span className="badge green">{t('task.running')} × {runningCount}</span>}
                </div>
                <div className="p-path">{w.path}</div>
                {!collapsed[w.workspaceId] && (
                <div className="p-sessions">
                  {wsSessions.map((s) => {
                    const proj = chats[s.sessionId]?.projValues?.title?.value;
                    const title =
                      (typeof proj === 'string' && proj.trim() ? proj : undefined) || projSessionTitle(s, locale);
                    return (
                      <div
                        key={s.sessionId}
                        className={`p-session ${s.sessionId === st.activeId ? 'active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => void st.openSession(s.sessionId)}
                        onKeyDown={(e) => e.key === 'Enter' && void st.openSession(s.sessionId)}
                      >
                        <span className={`t-dot ${s.running ? 'running' : ''}`} />
                        <span className="p-s-title">{title}</span>
                        <span className="p-s-time">{relTime(s.updatedAt, locale)}</span>
                      </div>
                    );
                  })}
                  {wsSessions.length === 0 && (
                    <div className="p-empty">{locale === 'zh' ? '该文件夹暂无任务' : 'No tasks in this folder'}</div>
                  )}
                </div>
                )}
                <div className="p-actions">
                  <button className="btn sm primary" onClick={() => { st.setNewTaskModal(true); }}><Icon name="plus" size={12} /> {t('projects.newTaskHere')}</button>
                  <button className="btn sm" onClick={() => {
                    const name = window.prompt(t('projects.rename'), w.title);
                    if (name && name.trim()) {
                      void dshOk('workspace.rename', { workspaceId: w.workspaceId, title: name.trim() }).then(() => st.refreshWorkspaces());
                    }
                  }}>{t('projects.rename')}</button>
                  <button className="btn sm" onClick={() => {
                    void dshOk('session.openWorkspacePath', { path: w.path })
                      .catch(async () => {
                        // dsh running as a service cannot open a desktop window —
                        // fall back to copying the path for the address bar
                        try { await navigator.clipboard.writeText(w.path); } catch { /* ignore */ }
                        st.toast('info', t('projects.openDirFallback'), w.path);
                      });
                  }}>
                    {t('projects.openDir')}
                  </button>
                  <button className="btn sm danger" onClick={async () => {
                    if (!window.confirm(t('common.confirmDelete'))) return;
                    await dshOk('workspace.delete', { workspaceId: w.workspaceId }).catch((e) => st.toast('error', e.message));
                    await st.refreshWorkspaces();
                  }}>{t('projects.delete')}</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
