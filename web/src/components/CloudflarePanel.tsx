// Click-driven cloudflared flow: download, login (auth link surfaced here so
// it opens in the user's browser session), quick tunnel with the scraped
// trycloudflare URL, and a named tunnel for a fixed address.

import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';

interface CfdState {
  installed?: boolean;
  loggedIn?: boolean;
  quickRunning?: boolean;
  quickUrl?: string;
  namedRunning?: boolean;
  loginUrl?: string;
}

export function CloudflarePanel({ onExternalUrl }: { onExternalUrl: (u: string) => void }) {
  const { t } = useI18n();
  const [st, setSt] = useState<CfdState | null>(null);
  const [busy, setBusy] = useState('');
  const [hostname, setHostname] = useState('');

  const call = async (path: string, tag: string, body?: unknown) => {
    setBusy(tag);
    try {
      const r = await fetch('/api/fe/cfd/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (localStorage.getItem('g4d_token') || '') },
        body: JSON.stringify(body || {}),
      }).then((x) => x.json());
      if (r && r.ok === false && r.error) useStore.getState().toast('error', r.error);
      return r;
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    try {
      const r = await fetch('/api/fe/cfd/status', {
        headers: { authorization: 'Bearer ' + (localStorage.getItem('g4d_token') || '') },
      }).then((x) => x.json());
      setSt(r);
      if (r.quickUrl && r.quickRunning) onExternalUrl(r.quickUrl);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t('wizard.cfTitle')}</div>
      <div className="hint" style={{ marginTop: 2 }}>{t('wizard.cfHint')}</div>

      {!st?.installed ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button className="btn sm primary" disabled={!!busy} onClick={() => void call('install', 'install')}>
            {busy === 'install' ? t('cf.downloading') : t('cf.install')}
          </button>
          <span className="hint">{t('cf.installHint')}</span>
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 6 }}>{t('cf.installed')} ✓</div>
      )}

      {/* quick tunnel: no login, no domain */}
      <div style={{ marginTop: 10, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('cf.quickTitle')}</div>
        <div className="hint">{t('cf.quickHint')}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {!st?.quickRunning ? (
            <button className="btn sm primary" disabled={!!busy || !st?.installed} onClick={() => void call('quick/start', 'quick')}>
              {busy === 'quick' ? t('common.loading') : t('cf.quickStart')}
            </button>
          ) : (
            <button className="btn sm" onClick={() => void call('quick/stop', '')}>{t('cf.quickStop')}</button>
          )}
          {st?.quickRunning && st?.quickUrl && (
            <span className="badge green">
              <a href={st.quickUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{st.quickUrl}</a>
            </span>
          )}
          {st?.quickRunning && !st?.quickUrl && <span className="hint">{t('cf.waitingUrl')}</span>}
        </div>
        {st?.quickRunning && st?.quickUrl && <div className="hint" style={{ marginTop: 4 }}>{t('cf.autoSaved')}</div>}
      </div>

      {/* fixed address: login + own domain */}
      <div style={{ marginTop: 10, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('cf.fixedTitle')}</div>
        <div className="hint">{t('cf.fixedHint')}</div>
        {!st?.loggedIn ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={!!busy || !st?.installed} onClick={() => void call('login', 'login')}>
              {t('cf.login')}
            </button>
            {st?.loginUrl && (
              <a href={st.loginUrl} target="_blank" rel="noreferrer" className="btn sm primary" style={{ textDecoration: 'none' }}>
                {t('cf.loginGo')} ↗
              </a>
            )}
            {st?.installed && <span className="hint">{t('cf.loginHint')}</span>}
          </div>
        ) : (
          <>
            <div className="hint" style={{ marginTop: 4 }}>{t('cf.loggedIn')} ✓</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
              <input className="input" style={{ flex: 1 }} placeholder="dsh.example.com" value={hostname} onChange={(e) => setHostname(e.target.value.trim())} />
              <button className="btn sm" disabled={!hostname || !!busy} onClick={() => void call('named/create', 'named', { hostname })}>
                {busy === 'named' ? t('common.loading') : t('cf.bind')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {!st?.namedRunning ? (
                <button className="btn sm primary" disabled={!!busy} onClick={() => void call('named/run', 'run')}>{t('cf.run')}</button>
              ) : (
                <button className="btn sm" onClick={() => void call('named/stop', '')}>{t('cf.stop')}</button>
              )}
              {st?.namedRunning && hostname && (
                <span className="badge green">
                  <a href={'https://' + hostname} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{'https://' + hostname}</a>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
