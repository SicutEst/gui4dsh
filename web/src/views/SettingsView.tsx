import React, { useEffect, useState } from 'react';
import { fe, dshCall } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { StatsView } from './StatsView';
import { HooksView } from './HooksView';
import type { GatewaySettings } from '../types';
import { storedTheme, applyTheme } from '../theme';

type Tab = 'general' | 'dsh' | 'creds' | 'stats' | 'hooks' | 'about';

interface NamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  applies: 'live' | 'restart';
  secrets: Array<{ path: string[]; set: boolean }>;
  revision: number;
}

export function SettingsView() {
  const { t, locale, setLocale } = useI18n();
  const st = useStore();
  const [tab, setTab] = useState<Tab>('general');

  return (
    <>
      <div className="topbar">
        <button className="mobile-toggle" onClick={() => st.setSidebar(true)}><Icon name="list" size={18} /></button>
        <h1><Icon name="gear" size={15} /> {t('settings.title')}</h1>
      </div>
      <div className="view-body">
        <div className="settings-nav">
          {(['general', 'dsh', 'creds', 'stats', 'hooks', 'about'] as Tab[]).map((x) => (
            <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
              {t(`settings.${x}`)}
            </button>
          ))}
        </div>
        {tab === 'general' && <GeneralTab />}
        {tab === 'dsh' && <DshTab />}
        {tab === 'creds' && <CredsTab />}
        {tab === 'stats' && <StatsView embedded />}
        {tab === 'hooks' && <HooksView embedded />}
        {tab === 'about' && <AboutTab />}
      </div>
    </>
  );

  function GeneralTab() {
    const [settings, setSettings] = useState<GatewaySettings | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
      fe.settings().then(setSettings);
    }, []);

    if (!settings) return <div style={{ color: 'var(--faint)' }}>{t('common.loading')}</div>;
    return (
      <div className="settings-cards2">
        <div className="card">
          <div className="field">
            <label>{t('settings.language')}</label>
            <select
              className="input"
              value={locale}
              onChange={(e) => {
                setLocale(e.target.value as 'zh' | 'en');
                void fe.saveSettings({ locale: e.target.value as 'zh' | 'en' });
              }}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
        <div className="card">
          <div className="field">
            <label>{t('settings.theme')}</label>
            <select
              className="input"
              value={storedTheme()}
              onChange={(e) => {
                localStorage.setItem('g4d_theme', e.target.value);
                applyTheme(e.target.value);
                void fe.saveSettings({ theme: e.target.value as 'dark' | 'light' | 'system' });
              }}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="light">{t('settings.light')}</option>
              <option value="dark">{t('settings.dark')}</option>
            </select>
          </div>
        </div>
        <div className="card">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t('settings.openBrowser')}</label>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.openBrowserOnStart}
                onChange={(e) => {
                  const next = { ...settings, openBrowserOnStart: e.target.checked };
                  setSettings(next);
                  void fe.saveSettings({ openBrowserOnStart: e.target.checked }).then(() => {
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1500);
                  });
                }}
              />
              <span className="track" />
            </label>
            {saved && <div className="badge green" style={{ marginLeft: 8 }}>{t('settings.dshSaved')}</div>}
          </div>
        </div>

        <PushCard settings={settings} onChange={(patch) => setSettings({ ...settings, ...patch } as GatewaySettings)} />

        <FrpCard settings={settings} onChange={(patch) => setSettings({ ...settings, ...patch } as GatewaySettings)} />
      </div>
    );
  }

  function PushCard({ settings, onChange }: { settings: GatewaySettings; onChange: (patch: Partial<GatewaySettings>) => void }) {
    const [testing, setTesting] = useState(false);
    const save = (patch: Partial<GatewaySettings>) => {
      onChange(patch);
      void fe.saveSettings(patch);
    };
    return (
      <div className="card">
        <div className="field">
          <label>{t('settings.pushChannel')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="input"
              style={{ maxWidth: 180 }}
              value={settings.pushChannel || 'off'}
              onChange={(e) => save({ pushChannel: e.target.value as 'off' | 'bark' | 'ntfy' })}
            >
              <option value="off">{t('settings.pushOff')}</option>
              <option value="bark">Bark (iOS)</option>
              <option value="ntfy">ntfy</option>
            </select>
            <button
              className="btn sm"
              disabled={testing || !settings.pushChannel || settings.pushChannel === 'off'}
              onClick={async () => {
                setTesting(true);
                try {
                  const r = await fe.pushTest();
                  st.toast(r.ok ? 'success' : 'error', r.ok ? t('settings.pushTestOk') : r.error || 'failed');
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? t('common.loading') : t('settings.pushTest')}
            </button>
          </div>
        </div>
        {settings.pushChannel === 'bark' && (
          <>
            <div className="field">
              <label>Bark Server</label>
              <input className="input" placeholder="https://api.day.app" value={settings.barkServer || ''} onChange={(e) => onChange({ ...settings, barkServer: e.target.value } as GatewaySettings)} onBlur={(e) => save({ barkServer: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('settings.barkKey')}</label>
              <input className="input" placeholder="xxxxxxxxxx" value={settings.barkKey || ''} onChange={(e) => onChange({ ...settings, barkKey: e.target.value } as GatewaySettings)} onBlur={(e) => save({ barkKey: e.target.value })} />
            </div>
          </>
        )}
        {settings.pushChannel === 'ntfy' && (
          <>
            <div className="field">
              <label>ntfy Server</label>
              <input className="input" placeholder="https://ntfy.sh" value={settings.ntfyServer || ''} onChange={(e) => onChange({ ...settings, ntfyServer: e.target.value } as GatewaySettings)} onBlur={(e) => save({ ntfyServer: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('settings.ntfyTopic')}</label>
              <input className="input" placeholder="gui4dsh-xxxx" value={settings.ntfyTopic || ''} onChange={(e) => onChange({ ...settings, ntfyTopic: e.target.value } as GatewaySettings)} onBlur={(e) => save({ ntfyTopic: e.target.value })} />
            </div>
          </>
        )}
        {settings.pushChannel && settings.pushChannel !== 'off' && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t('settings.pushOnTurnEnd')}</label>
              <label className="switch">
                <input type="checkbox" checked={settings.pushOnTurnEnd !== false} onChange={(e) => save({ pushOnTurnEnd: e.target.checked })} />
                <span className="track" />
              </label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t('settings.pushOnApproval')}</label>
              <label className="switch">
                <input type="checkbox" checked={settings.pushOnApproval !== false} onChange={(e) => save({ pushOnApproval: e.target.checked })} />
                <span className="track" />
              </label>
            </div>
          </div>
        )}
      </div>
    );
  }

  function FrpCard({ settings, onChange }: { settings: GatewaySettings; onChange: (patch: Partial<GatewaySettings>) => void }) {
    const [stat, setStat] = useState<{ running: boolean; log: string[] } | null>(null);
    useEffect(() => {
      fe.frpStatus().then(setStat);
      const iv = setInterval(() => void fe.frpStatus().then(setStat), 10000);
      return () => clearInterval(iv);
    }, []);
    const save = (patch: Partial<GatewaySettings>) => {
      onChange(patch);
      void fe.saveSettings(patch);
    };
    const num = (v: string) => (v === '' ? undefined : Number(v));
    return (
      <div className="card">
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('settings.frpTitle')}
            <span className={`dot ${stat?.running ? 'ok' : 'bad'}`} style={{ width: 8, height: 8, borderRadius: 4 }} />
            {stat?.running ? t('settings.frpRunning') : t('settings.frpStopped')}
          </label>
        </div>
        <div className="field">
          <label>{t('settings.frpcPath')}</label>
          <input className="input" placeholder="frpc（PATH 里）或 D:\frp\frpc.exe" value={settings.frpcPath || ''} onChange={(e) => onChange({ ...settings, frpcPath: e.target.value } as GatewaySettings)} onBlur={(e) => save({ frpcPath: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label>{t('settings.frpServer')}</label>
            <input className="input" placeholder="1.2.3.4" value={settings.frpServer || ''} onChange={(e) => onChange({ ...settings, frpServer: e.target.value } as GatewaySettings)} onBlur={(e) => save({ frpServer: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 100px' }}>
            <label>{t('settings.frpServerPort')}</label>
            <input className="input" placeholder="7000" value={settings.frpServerPort || ''} onChange={(e) => onChange({ ...settings, frpServerPort: e.target.value } as GatewaySettings)} onBlur={(e) => save({ frpServerPort: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 100px' }}>
            <label>{t('settings.frpRemotePort')}</label>
            <input className="input" placeholder="7421" value={settings.frpRemotePort ?? ''} onChange={(e) => onChange({ ...settings, frpRemotePort: num(e.target.value) } as GatewaySettings)} onBlur={(e) => save({ frpRemotePort: num(e.target.value) })} />
          </div>
        </div>
        <div className="field">
          <label>Token</label>
          <input className="input" type="password" placeholder="frps auth.token" value={settings.frpToken || ''} onChange={(e) => onChange({ ...settings, frpToken: e.target.value } as GatewaySettings)} onBlur={(e) => save({ frpToken: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn sm primary"
            onClick={async () => {
              const r = await fe.frpStart();
              if (!r.ok) st.toast('error', r.error || 'start failed');
              setStat(await fe.frpStatus());
            }}
          >
            {t('settings.frpStart')}
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              await fe.frpStop();
              setStat(await fe.frpStatus());
            }}
          >
            {t('settings.frpStop')}
          </button>
          <div className="field" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ marginBottom: 0 }}>{t('settings.frpAutoStart')}</label>
            <label className="switch">
              <input type="checkbox" checked={settings.frpEnabled === true} onChange={(e) => save({ frpEnabled: e.target.checked })} />
              <span className="track" />
            </label>
          </div>
        </div>
        {stat && stat.log.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--faint)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 90, overflowY: 'auto' }}>
            {stat.log.slice(-8).join('\n')}
          </div>
        )}
      </div>
    );
  }


  function DshTab() {
    const [namespaces, setNamespaces] = useState<NamespaceView[] | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [openNs, setOpenNs] = useState<string | null>(null);
    const [err, setErr] = useState<Record<string, string>>({});
    const [ok, setOk] = useState<Record<string, boolean>>({});

    useEffect(() => {
      dshCall<{ namespaces: NamespaceView[] }>('settings.describe', {}).then((r) => {
        if (r.ok) setNamespaces(r.value!.namespaces || []);
      });
    }, []);

    if (!namespaces) return <div style={{ color: 'var(--faint)' }}>{t('common.loading')}</div>;

    const saveNs = async (n: NamespaceView) => {
      const raw = drafts[n.ns];
      let patch: object;
      try {
        patch = JSON.parse(raw || '{}');
      } catch {
        setErr({ ...err, [n.ns]: t('settings.dshInvalidJson') });
        return;
      }
      const res = await dshCall('settings.update', { ns: n.ns, patch, expectedRevision: n.revision });
      if (res.ok) {
        setOk({ ...ok, [n.ns]: true });
        setErr({ ...err, [n.ns]: '' });
        setTimeout(() => setOk({ ...ok, [n.ns]: false }), 1500);
        const r2 = await dshCall<{ namespaces: NamespaceView[] }>('settings.describe', {});
        if (r2.ok) setNamespaces(r2.value!.namespaces || []);
      } else {
        setErr({ ...err, [n.ns]: res.error?.message || 'save failed' });
      }
    };

    return (
      <>
        <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 12 }}>{t('settings.dshHint')}</div>
        {namespaces.map((n) => (
          <div key={n.ns} className="card ns-card">
            <div className="ns-head" style={{ cursor: 'pointer' }} onClick={() => setOpenNs(openNs === n.ns ? null : n.ns)}>
              <span style={{ fontSize: 12 }}>{openNs === n.ns ? '▾' : '▸'}</span>
              <span className="ns-name">{n.ns}</span>
              <span className={`badge ${n.applies === 'live' ? 'green' : 'yellow'}`}>
                {n.applies === 'live' ? t('settings.dshAppliesLive') : t('settings.dshAppliesRestart')}
              </span>
              <span className="badge">{t('settings.dshRevision')} {n.revision}</span>
            </div>
            {openNs === n.ns && (
              <>
                {n.secrets.length > 0 && (
                  <div style={{ marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>{t('settings.dshSecrets')}:</span>
                    {n.secrets.map((s, i) => (
                      <span key={i} className={`badge ${s.set ? 'green' : ''}`}>
                        {s.path.join('.')} · {s.set ? t('settings.dshSecretSet') : t('settings.dshSecretUnset')}
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  className="input json"
                  value={drafts[n.ns] ?? JSON.stringify(n.value ?? {}, null, 2)}
                  onChange={(e) => setDrafts({ ...drafts, [n.ns]: e.target.value })}
                  spellCheck={false}
                />
                {err[n.ns] && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err[n.ns]}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <button className="btn primary sm" onClick={() => void saveNs(n)}>{t('settings.dshSave')}</button>
                  {ok[n.ns] && <span className="badge green">✓ {t('settings.dshSaved')}</span>}
                </div>
              </>
            )}
          </div>
        ))}
      </>
    );
  }

  function CredsTab() {
    const [ref, setRef] = useState('DEEPSEEK_API_KEY');
    const [value, setValue] = useState('');
    const [state, setState] = useState<Record<string, { configured: boolean; writable: boolean; source?: string }> | null>(null);

    const describe = async (r: string) => {
      const res = await dshCall<{ credentials: Record<string, { configured: boolean; writable: boolean; source?: string }> }>(
        'credentials.describe',
        { refs: [r] },
      );
      if (res.ok) setState(res.value!.credentials);
    };
    useEffect(() => {
      void describe(ref);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div className="card">
        <div className="field">
          <label>{t('settings.credRef')}</label>
          <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} onBlur={() => describe(ref)} />
        </div>
        {state?.[ref] && (
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            <span className={`badge ${state[ref].configured ? 'green' : ''}`}>
              {state[ref].configured ? `${t('settings.credConfigured')} (${state[ref].source})` : t('settings.credNotConfigured')}
            </span>
          </div>
        )}
        <div className="field">
          <label>{t('settings.credValue')}</label>
          <input className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn primary"
            disabled={!value.trim()}
            onClick={async () => {
              const res = await dshCall('credentials.set', { ref, value: value.trim() });
              if (res.ok) {
                setValue('');
                st.toast('success', t('settings.dshSaved'));
                await describe(ref);
              } else {
                st.toast('error', res.error?.message || 'set failed');
              }
            }}
          >
            {t('settings.credSet')}
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              const res = await dshCall('credentials.unset', { ref });
              if (res.ok) await describe(ref);
              else st.toast('error', res.error?.message || 'unset failed');
            }}
          >
            {t('settings.credUnset')}
          </button>
        </div>
      </div>
    );
  }

  function AboutTab() {
    const [dshVersion, setDshVersion] = useState('');
    useEffect(() => {
      dshCall<{ version: string }>('host.describe', {}).then((r) => {
        if (r.ok) setDshVersion(r.value!.version);
      });
      fe.health().then((h) => setDshVersion((v) => v || h.dsh));
    }, []);
    return (
      <div className="card">
        <p style={{ lineHeight: 1.8, color: 'var(--dim)' }}>{t('settings.aboutText')}</p>
        <div className="kv" style={{ marginTop: 12 }}>
          <span className="k">gui4dsh</span>
          <span className="badge">v0.1.0</span>
        </div>
        {dshVersion && (
          <div className="kv">
            <span className="k">{t('settings.dshVersion')}</span>
            <span className="badge blue mono">{dshVersion}</span>
          </div>
        )}
        <div className="kv">
          <span className="k">GitHub</span>
          <span style={{ fontSize: 12.5 }} className="mono">github.com/deepseek-ai/deepseek-harness</span>
        </div>
      </div>
    );
  }
}
