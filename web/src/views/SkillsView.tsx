import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore, ensureAnySession } from '../store';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import type { SkillEntry, SkillGroup } from '../types';

const GROUP_COLORS = ['#5b7cfa', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8'];

export function SkillsView() {
  const { t } = useI18n();
  const st = useStore();
  const skills = useStore((s) => s.skills);
  const [filter, setFilter] = useState('');
  const [groups, setGroups] = useState<SkillGroup[]>([]);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [managed, setManaged] = useState(false);

  useEffect(() => {
    void ensureAnySession().then(() => st.refreshSkills());
    fe.skillsMeta().then((r) => {
      setGroups(r.groups || []);
      setAssign(r.assign || {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = async (g: SkillGroup[], a: Record<string, string>) => {
    setGroups(g);
    setAssign(a);
    await fe.saveSkillsMeta({ groups: g, assign: a });
  };

  const filtered = skills.filter(
    (s) => !filter.trim() || s.name.toLowerCase().includes(filter.toLowerCase()) || s.description.toLowerCase().includes(filter.toLowerCase()),
  );

  const invoke = (s: SkillEntry) => {
    const sid = st.activeId;
    if (sid) {
      st.setComposerPreset(`/${s.name} `);
      st.setView('chat');
    } else {
      void st.newTask({ prompt: `/${s.name}` });
    }
  };

  const SkillCard = ({ s }: { s: SkillEntry }) => (
    <div className="card skill-card hover">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className="sk-name">/{s.name}</span>
        <span style={{ flex: 1 }} />
        <span className={`badge ${s.modelInvocable ? 'blue' : 'violet'}`}>
          {s.modelInvocable ? t('skills.modelInvocable') : t('skills.userOnly')}
        </span>
      </div>
      <div className="sk-desc">{s.description}</div>
      {s.whenToUse && <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 4 }}>{s.whenToUse}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button className="btn sm primary" onClick={() => invoke(s)}>{t('skills.invoke')}</button>
        <span style={{ flex: 1 }} />
        <select
          className="btn sm"
          style={{ maxWidth: 140 }}
          value={assign[s.name] || ''}
          onChange={(e) => void persist(groups, { ...assign, [s.name]: e.target.value })}
        >
          <option value="">{t('skills.ungrouped')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
      </div>
    </div>
  );

  const customGrouped = groups.map((g) => {
    const items = filtered.filter((s) => assign[s.name] === g.id);
    return { g, items };
  });
  const ungrouped = filtered.filter((s) => !assign[s.name] || !groups.some((g) => g.id === assign[s.name]));

  return (
    <>
      <div className="topbar">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <h1><Icon name="command" size={15} /> {t('skills.title')}</h1>
        <div style={{ flex: 1 }} />
        <input
          className="input"
          style={{ width: 200 }}
          placeholder={t('skills.searchPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn" onClick={() => setManaged(!managed)}><Icon name="folder" size={13} /> {t('sidebar.groups')}</button>
      </div>
      <div className="view-body">
        {managed && (
          <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn sm"
              onClick={() => {
                const title = window.prompt(t('skills.groupName'));
                if (title && title.trim()) {
                  void persist([...groups, { id: Math.random().toString(36).slice(2), title: title.trim(), color: GROUP_COLORS[groups.length % GROUP_COLORS.length] }], assign);
                }
              }}
            >
              <Icon name="plus" size={12} /> {t('skills.newGroup')}
            </button>
            {groups.map((g) => (
              <span key={g.id} className="badge" style={{ gap: 8, padding: '4px 10px' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: g.color }} />
                {g.title}
                <button
                  style={{ border: 'none', background: 'transparent', color: 'var(--red)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                  onClick={() => {
                    const next = groups.filter((x) => x.id !== g.id);
                    const nextAssign = { ...assign };
                    for (const k of Object.keys(nextAssign)) if (nextAssign[k] === g.id) delete nextAssign[k];
                    void persist(next, nextAssign);
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {skills.length === 0 && <div style={{ color: 'var(--faint)', padding: 20 }}>{t('skills.needSession')}</div>}

        {customGrouped.map(({ g, items }) =>
          items.length > 0 ? (
            <div key={g.id} style={{ marginBottom: 20 }}>
              <div className="task-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: g.color }} />
                {g.title} ({items.length})
              </div>
              <div className="skill-grid">{items.map((s) => <SkillCard key={s.name} s={s} />)}</div>
            </div>
          ) : null,
        )}
        {ungrouped.length > 0 && (
          <div>
            {customGrouped.some((x) => x.items.length > 0) && (
              <div className="task-section-title">{t('skills.ungrouped')} ({ungrouped.length})</div>
            )}
            <div className="skill-grid">{ungrouped.map((s) => <SkillCard key={s.name} s={s} />)}</div>
          </div>
        )}
      </div>
    </>
  );
}
