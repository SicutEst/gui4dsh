import React, { useEffect, useRef, useState } from 'react';
import { dshCall } from '../api';
import { useStore } from '../store';
import { useI18n, relTime } from '../i18n';
import { Icon } from '../components/Icon';

interface SearchItem {
  sessionId: string;
  snippet: string;
}

export function SearchView() {
  const { t, locale } = useI18n();
  const st = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // focus input + Esc to close
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') st.setView('chat');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setSearched(true);
    const res = await dshCall<{ items: SearchItem[]; hasMore: boolean }>('session.search', { query });
    setLoading(false);
    if (res.ok) {
      setResults(res.value?.items || []);
      setHasMore(!!res.value?.hasMore);
    } else {
      st.toast('error', res.error?.message || 'search failed');
    }
  };

  const openResult = (sid: string) => {
    st.setView('chat');
    void st.openSession(sid);
  };

  const highlight = (snippet: string) => {
    const terms = q.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return snippet;
    const re = new RegExp(`(${terms.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const parts = snippet.split(re);
    return parts.map((p, i) => (re.test(p) && i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>));
  };

  const titleOf = (sid: string) => {
    const s = st.sessions.find((x) => x.sessionId === sid);
    if (!s) return sid.slice(0, 13) + '…';
    const proj = st.chats[sid]?.projValues?.title?.value;
    return (
      (typeof proj === 'string' && proj) ||
      (typeof s.projections?.values?.title === 'string' && (s.projections.values.title as string)) ||
      (s.cwd ? s.cwd.split(/[\\/]/).pop() : t('task.untitled'))
    );
  };

  return (
    <div className="modal-overlay" onClick={() => st.setView('chat')}>
      <div
        className="search-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('search.title')}
      >
        <div className="search-panel-input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
              if (e.key === 'Escape') st.setView('chat');
            }}
          />
          <button className="btn sm" onClick={() => st.setView('chat')}><Icon name="x" size={12} /></button>
        </div>

        <div className="search-panel-body">
          {!searched && !loading && (
            <div className="search-panel-hint">{t('search.hint')}</div>
          )}
          {loading && <div className="search-panel-hint">{t('common.loading')}</div>}
          {searched && !loading && results.length === 0 && (
            <div className="search-panel-hint">{t('search.noResults')}</div>
          )}
          {hasMore && <div className="badge yellow" style={{ marginBottom: 10 }}>{t('search.hasMore')}</div>}
          {results.map((r) => {
            const s = st.sessions.find((x) => x.sessionId === r.sessionId);
            return (
              <div key={r.sessionId} className="search-result" role="button" tabIndex={0} onClick={() => openResult(r.sessionId)}>
                <div className="r-title">
                  {titleOf(r.sessionId)}
                  <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 11.5, marginLeft: 8 }}>
                    {s?.cwd?.split(/[\\/]/).pop()} · {relTime(s?.updatedAt, locale)}
                  </span>
                </div>
                <div className="r-snippet">{highlight(r.snippet)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
