import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface Summary {
  turn: number;
  files: Array<{ path: string; display: string; added: number; deleted: number }>;
  total: number;
  added: number;
  deleted: number;
}

const cache = new Map<string, Summary | 'loading' | 'error'>();

/** One turn's workspace file changes (0.1.7 workspace/changes summary). */
export function TurnChanges({ sessionId, seq }: { sessionId: string; seq: number }) {
  const { t } = useI18n();
  const key = `${sessionId}:${seq}`;
  const [summary, setSummary] = useState<Summary | null>(cache.get(key) && cache.get(key) !== 'loading' && cache.get(key) !== 'error' ? (cache.get(key) as Summary) : null);
  const [failed, setFailed] = useState(cache.get(key) === 'error');

  useEffect(() => {
    if (cache.has(key)) {
      const v = cache.get(key)!;
      setSummary(v !== 'loading' && v !== 'error' ? v : null);
      setFailed(v === 'error');
      return;
    }
    cache.set(key, 'loading');
    fe.changesSummary(sessionId, seq).then((s) => {
      cache.set(key, s);
      setSummary(s);
    }).catch(() => {
      cache.set(key, 'error');
      setFailed(true);
    });
  }, [key]);

  if (failed || !summary || summary.files.length === 0) return null;
  return (
    <div className="deliver-row">
      <span className="d-label">{t('changes.label')}</span>
      {summary.files.map((f) => (
        <button
          key={f.path}
          className="d-chip"
          title={f.path}
          onClick={() => {
            void navigator.clipboard?.writeText(f.path);
          }}
        >
          <Icon name="file" size={11} />
          <span className="d-name">{f.display}</span>
          <span className="d-op">{`+${f.added}/-${f.deleted}`}</span>
        </button>
      ))}
      {summary.total > summary.files.length && (
        <span className="d-label">{t('changes.more', { n: summary.total - summary.files.length })}</span>
      )}
    </div>
  );
}
