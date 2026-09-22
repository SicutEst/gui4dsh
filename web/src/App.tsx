import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useStore } from './store';
import { useI18n } from './i18n';
import { getToken, setToken, clearToken, fe } from './api';
import { Icon, DeepSeekWhale } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ApprovalDialog, QuestionDialog, NewTaskModal } from './components/Dialogs';
import { RemoteModal } from './components/RemoteModal';
import { SearchView } from './views/SearchView';
import { AutomationsView } from './views/AutomationsView';
import { SkillsView } from './views/SkillsView';
import { ProjectsView } from './views/ProjectsView';
import { StatsView } from './views/StatsView';
import { HooksView } from './views/HooksView';
import { SettingsView } from './views/SettingsView';
import { applyTheme, storedTheme, watchSystemTheme } from './theme';

export function App() {
  const { t } = useI18n();
  const [authState, setAuthState] = useState<'checking' | 'pairing' | 'ok'>('checking');
  const [pairError, setPairError] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);

  const st = useStore();
  const { boot, booted, view, sidebarOpen, toasts, dismissToast, qrModal } = st;

  const tryCode = async (code: string) => {
    setCodeBusy(true);
    setCodeError('');
    try {
      const r = await fe.exchangePaircode(code);
      if (r.ok && r.token) {
        setToken(r.token);
        await fe.verify();
        setAuthState('ok');
        setCodeInput('');
      } else {
        setCodeError(t(r.error === 'expired' ? 'pairing.codeExpired' : r.error === 'invalid-code' ? 'pairing.codeInvalid' : 'pairing.codeWrong'));
      }
    } catch {
      setCodeError(t('pairing.codeWrong'));
    } finally {
      setCodeBusy(false);
    }
  };

  // --- pairing gate
  const tryToken = async (token: string) => {
    setToken(token);
    try {
      await fe.verify();
      setAuthState('ok');
      setPairError('');
    } catch {
      clearToken();
      setPairError(t('pairing.invalid'));
      setAuthState('pairing');
    }
  };

  useEffect(() => {
    applyTheme(storedTheme());
    const stopWatch = watchSystemTheme();
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const hashToken = hash.get('token');
    if (hashToken) {
      // strip only the token, keep other params (e.g. #s= session deep link)
      hash.delete('token');
      const rest = hash.toString();
      history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
      void tryToken(hashToken);
      stopWatch();
      return;
    }
    const saved = getToken();
    if (saved) {
      void tryToken(saved);
    } else {
      // loopback auto-pair: on the PC itself (127.0.0.1/localhost) no code is needed
      fe.autoPair()
        .then((r) => {
          if (r.ok && r.token) void tryToken(r.token);
          else setAuthState('pairing');
        })
        .catch(() => setAuthState('pairing'));
    }
    return stopWatch;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // gateway:notification toast for unauthorized
  useEffect(() => {
    const onUnauth = () => setAuthState('pairing');
    window.addEventListener('g4d:unauthorized', onUnauth);
    return () => window.removeEventListener('g4d:unauthorized', onUnauth);
  }, []);

  useEffect(() => {
    if (authState === 'ok' && !booted) void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, booted]);

  // deep link: #s=<sessionId> opens that session (mobile share / external links)
  useEffect(() => {
    const openFromHash = () => {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const sid = params.get('s');
      if (sid && authState === 'ok') void st.openSession(sid);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  // mobile edge gestures: swipe right from the left edge opens the sidebar,
  // swipe left anywhere closes it (mirrors the backdrop tap)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    if (!mq.matches) return;
    let sx = 0, sy = 0, tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      tracking = true;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (!st.sidebarOpen && sx < 44 && dx > 0) st.setSidebar(true);
      else if (st.sidebarOpen && dx < 0) st.setSidebar(false);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.sidebarOpen]);

  // auto-update: periodically check for a newer bundle and reload transparently
  useEffect(() => {
    if (authState !== 'ok') return;
    const currentBundle = (): string => {
      const s = document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') || '';
      return s;
    };
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/?t=${Date.now()}`, { cache: 'no-store' });
        const html = await res.text();
        const m = html.match(/assets\/index-[^"]+\.js/);
        if (m && currentBundle() && !currentBundle().includes(m[0])) {
          // newer build on the server — reload once, then versions match and it stops
          location.reload();
        }
      } catch {
        /* offline; try again next cycle */
      }
    };
    const timer = window.setInterval(check, 4 * 60_000);
    const onVis = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  // auto-resync: page returns to foreground, network recovers, or periodic sweep
  useEffect(() => {
    if (authState !== 'ok') return;
    let timer: number | undefined;
    let lastRun = 0;
    const sync = () => {
      const now = Date.now();
      if (document.hidden || now - lastRun < 2000) return;
      lastRun = now;
      void st.resyncAll();
    };
    const onVis = () => {
      if (!document.hidden) sync();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
    timer = window.setInterval(sync, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', sync);
      window.removeEventListener('online', sync);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  if (authState === 'checking') {
    return (
      <div className="pairing">
        <div className="pairing-box">
          <div className="brand-logo"><DeepSeekWhale size={38} /></div>
          <p>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (authState === 'pairing') {
    return (
      <div className="pairing">
        <div className="pairing-box">
          <div className="brand-logo"><DeepSeekWhale size={38} /></div>
          <h1>{t('pairing.title')}</h1>
          <p style={{ textAlign: 'left' }}>{t('pairing.explain')}</p>
          <ol style={{ textAlign: 'left', color: 'var(--dim)', fontSize: 12.5, lineHeight: 1.9, margin: '0 0 18px 18px' }}>
            <li>{t('pairing.step1')}</li>
            <li>{t('pairing.step2')}</li>
            <li>{t('pairing.step3')}</li>
          </ol>
          <button
            className="btn"
            style={{ width: '100%', marginBottom: 8 }}
            disabled={localBusy}
            onClick={async () => {
              setLocalBusy(true);
              try {
                const r = await fe.autoPair();
                if (r.ok && r.token) {
                  setToken(r.token);
                  await fe.verify();
                  setAuthState('ok');
                } else {
                  setCodeError(t('pairing.localDenied'));
                }
              } catch {
                setCodeError(t('pairing.localDenied'));
              } finally {
                setLocalBusy(false);
              }
            }}
          >
            {localBusy ? t('common.loading') : t('pairing.localBtn')}
          </button>
          <div style={{ fontSize: 11.5, color: 'var(--faint)', marginBottom: 16, lineHeight: 1.6, textAlign: 'left' }}>
            {t('pairing.homescreen')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 14px' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border2)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>{t('pairing.or')}</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border2)' }} />
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 8, textAlign: 'left', fontWeight: 700 }}>
            {t('pairing.codeLabel')}
          </div>
          <input
            className="input"
            style={{ marginBottom: 10, textAlign: 'center', fontSize: 20, letterSpacing: 8, fontFamily: 'Cascadia Code, Consolas, monospace' }}
            placeholder="000000"
            maxLength={6}
            inputMode="numeric"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && codeInput.length === 6 && tryCode(codeInput)}
          />
          {codeError && <div className="pairing-err">{codeError}</div>}
          <button
            className="btn primary"
            style={{ width: '100%', marginBottom: 6 }}
            disabled={codeInput.length !== 6 || codeBusy}
            onClick={() => void tryCode(codeInput)}
          >
            {codeBusy ? t('common.loading') : t('pairing.codeSubmit')}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border2)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>{t('pairing.or')}</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border2)' }} />
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 8, textAlign: 'left', fontWeight: 700 }}>
            {t('pairing.tokenLabel')}
          </div>
          <input
            className="input mono"
            placeholder={t('pairing.tokenPlaceholder')}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && tokenInput.trim() && tryToken(tokenInput.trim())}
            style={{ marginBottom: 12 }}
          />
          <button className="btn" style={{ width: '100%' }} disabled={!tokenInput.trim()} onClick={() => tryToken(tokenInput.trim())}>
            {t('pairing.submit')}
          </button>
          {pairError && <div className="pairing-err">{pairError}</div>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="app">
        <Sidebar />
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => st.setSidebar(false)} />}
        <div className="main">
          {view === 'chat' && <ChatView />}
          {view === 'automations' && <AutomationsView />}
          {view === 'skills' && <SkillsView />}
          {view === 'projects' && <ProjectsView />}
          {view === 'stats' && <StatsView />}
          {view === 'hooks' && <HooksView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>

      <NewTaskModal />
      {view === 'search' && <SearchView />}
      {st.remoteOpen && <RemoteModal onClose={() => st.setRemoteOpen(false)} />}
      {qrModal && (
        <div className="modal-overlay" onClick={() => st.setQrModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 340 }}>
            <div className="qr-box">
              <div className="qr-white">
                <QRCodeSVG value={qrModal} size={224} />
              </div>
              <div className="url">{qrModal}</div>
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(qrModal)}><Icon name="copy" size={12} /> {t('common.copy')}</button>
            </div>
          </div>
        </div>
      )}

      <PendingDialogs />
      <div className="toasts">
        {toasts.map((tt) => (
          <div key={tt.id} className={`toast ${tt.level}`} onClick={() => dismissToast(tt.id)}>
            <div className="t-title">{tt.title}</div>
            {tt.body && <div className="t-body">{tt.body}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

function PendingDialogs() {
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const approval = Object.values(approvals)[0];
  const question = Object.values(questions)[0];
  return (
    <>
      {approval && <ApprovalDialog key={approval.approvalId} approval={approval} />}
      {question && <QuestionDialog key={question.rpcId} question={question} />}
    </>
  );
}
