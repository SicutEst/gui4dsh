import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';

interface MemFile { name: string; content: string }

export function MemoryView() {
  const { t, locale } = useI18n();
  const st = useStore();
  const [enabled, setEnabled] = useState(false);
  const [dir, setDir] = useState('');
  const [files, setFiles] = useState<MemFile[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async (keepSel?: string | null) => {
    const r = await fe.memoryList();
    if ('files' in (r as object)) {
      setEnabled((r as any).enabled);
      setDir((r as any).dir || '');
      setFiles((r as any).files || []);
      const next = keepSel !== undefined ? keepSel : sel;
      if (next && (r as any).files?.some((f: MemFile) => f.name === next)) {
        setDraft(((r as any).files as MemFile[]).find((f) => f.name === next)!.content);
        setDirty(false);
      } else if (keepSel === null) {
        setSel(null);
        setDraft('');
      }
    }
  };

  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (f: MemFile) => {
    setSel(f.name);
    setDraft(f.content);
    setDirty(false);
    setCreating(false);
  };

  const save = async () => {
    if (!sel) return;
    const name = creating ? `${newName.trim()}.md` : sel;
    if (creating && !newName.trim()) return;
    const r = await fe.memoryWrite(name, draft);
    if (!r.ok) return;
    setCreating(false);
    setSel(name);
    await load(name);
  };

  const remove = async () => {
    if (!sel || creating) return;
    if (!window.confirm(t('mem.confirmDel') + ' ' + sel + '?')) return;
    await fe.memoryDelete(sel);
    setSel(null);
    setDraft('');
    await load(null);
  };

  const toggle = async () => {
    const next = !enabled;
    const r = await fe.memoryToggle(next);
    if (!r.ok) return;
    if (next && files.length === 0) {
      // seed the index so the agent knows where to look
      await fe.memoryWrite(
        'MEMORY.md',
        locale === 'zh'
          ? '# 记忆索引\n\n<!-- 每条记忆一行：- [标题](文件.md) — 一句话钩子 -->\n'
          : '# Memory Index\n\n<!-- one bullet per memory: - [title](file.md) — one-line hook -->\n',
      );
    }
    await load(next ? 'MEMORY.md' : null);
  };

  const selTitle = sel ? (sel === 'MEMORY.md' ? (locale === 'zh' ? '索引' : 'Index') : sel.replace(/\.md$/, '')) : '';

  return (
    <>
      <div className="topbar">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <h1><Icon name="brain" size={15} /> {t('nav.memory')}</h1>
        <span style={{ fontSize: 11, color: 'var(--faint)' }} className="hide-sm">{dir}</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={12} /> {t('mem.new')}
        </button>
        <button className={`btn sm ${enabled ? 'primary' : ''}`} onClick={() => void toggle()}>
          <Icon name={enabled ? 'check' : 'x'} size={12} /> {enabled ? t('mem.on') : t('mem.off')}
        </button>
      </div>
      <div className="mem-wrap">
        <div className={`mem-banner ${enabled ? 'ok' : ''}`}>
          <Icon name="info" size={13} />
          {enabled ? t('mem.enabledHint') : t('mem.disabledHint')}
        </div>
        <div className="mem-layout">
          <div className="mem-list">
            {files.map((f) => (
              <div key={f.name} className={`mem-row ${sel === f.name && !creating ? 'sel' : ''}`} onClick={() => open(f)}>
                <Icon name={f.name === 'MEMORY.md' ? 'list' : 'file'} size={12} />
                <span className="m-name">{f.name === 'MEMORY.md' ? (locale === 'zh' ? '索引 MEMORY.md' : 'Index MEMORY.md') : f.name}</span>
                <span className="m-hook">{firstLine(f.content).slice(0, 40)}</span>
              </div>
            ))}
            {files.length === 0 && <div className="mem-empty">{t('mem.empty')}</div>}
          </div>
          <div className="mem-editor">
            {(sel || creating) && (
              <>
                <div className="mem-editor-head">
                  <b>{creating ? (
                    <input
                      className="input"
                      style={{ width: 180, fontSize: 12 }}
                      placeholder={t('mem.namePh')}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  ) : selTitle}</b>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{creating ? '.md' : sel}</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn sm" onClick={() => void remove()} disabled={creating || sel === 'MEMORY.md'}>
                    <Icon name="trash" size={12} />
                  </button>
                  <button className="btn sm primary" disabled={creating ? !newName.trim() : !dirty} onClick={() => void save()}>
                    {t('mem.save')}
                  </button>
                </div>
                <textarea
                  className="mem-text"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                  spellCheck={false}
                />
              </>
            )}
            {!sel && !creating && <div className="mem-empty">{t('mem.pick')}</div>}
          </div>
        </div>
      </div>
    </>
  );
}

function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim() && !l.trim().startsWith('<!--') && !l.trim().startsWith('#'));
  return (line || '').replace(/^[-*]\s*/, '').trim();
}
