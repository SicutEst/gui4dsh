import React, { useEffect, useState } from 'react';
import { fe, dshCall } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { StatsView } from './StatsView';
import { HooksView } from './HooksView';
import type { GatewaySettings } from '../types';
import { storedTheme, applyTheme } from '../theme';

type Tab = 'general' | 'models' | 'frp' | 'dsh' | 'stats' | 'hooks' | 'about';

interface NamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  applies: 'live' | 'restart';
  secrets: Array<{ path: string[]; set: boolean }>;
  revision: number;
}

/** Preset catalogue for the add-provider form: mainstream OpenAI-compatible endpoints. */
const LLM_PRESETS: Array<{ key: string; name: string; id: string; baseURL: string; api: string; models: string; keyPh?: string }> = [
  { key: 'siliconflow', name: '硅基流动 SiliconFlow', id: 'siliconflow', baseURL: 'https://api.siliconflow.cn/v1', api: 'openai-completions', models: 'deepseek-ai/DeepSeek-V3.2-Exp | DeepSeek V3.2\nQwen/Qwen3-235B-A22B | Qwen3 235B\nmoonshotai/Kimi-K2-Instruct | Kimi K2' },
  { key: 'zhipu', name: '智谱 GLM（开放平台）', id: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', models: 'glm-4.7 | GLM-4.7\nglm-4.7-flash | GLM-4.7 Flash' },
  { key: 'moonshot', name: '月之暗面 Kimi', id: 'moonshot', baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions', models: 'kimi-k2 | Kimi K2\nmoonshot-v1-128k | Moonshot 128K' },
  { key: 'dashscope', name: '阿里通义千问', id: 'dashscope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', models: 'qwen3-max | Qwen3 Max\nqwen3-plus | Qwen3 Plus' },
  { key: 'deepseek', name: 'DeepSeek 官方', id: 'deepseek-api', baseURL: 'https://api.deepseek.com/v1', api: 'openai-completions', models: 'deepseek-chat | DeepSeek Chat\ndeepseek-reasoner | DeepSeek Reasoner' },
  { key: 'openai', name: 'OpenAI', id: 'openai', baseURL: 'https://api.openai.com/v1', api: 'openai-completions', models: 'gpt-5.2 | GPT-5.2\ngpt-5-mini | GPT-5 mini' },
  { key: 'anthropic', name: 'Anthropic Claude', id: 'anthropic', baseURL: 'https://api.anthropic.com', api: 'anthropic-messages', models: 'claude-sonnet-4-5 | Claude Sonnet 4.5\nclaude-opus-4-5 | Claude Opus 4.5' },
  { key: 'gemini', name: 'Google Gemini', id: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', api: 'openai-completions', models: 'gemini-3-pro | Gemini 3 Pro\ngemini-3-flash | Gemini 3 Flash' },
  { key: 'grok', name: 'xAI Grok', id: 'grok', baseURL: 'https://api.x.ai/v1', api: 'openai-completions', models: 'grok-4 | Grok 4\ngrok-4-fast | Grok 4 Fast' },
  { key: 'openrouter', name: 'OpenRouter（聚合）', id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', api: 'openai-completions', models: 'deepseek/deepseek-chat | DeepSeek Chat\nanthropic/claude-sonnet-4.5 | Sonnet 4.5\nopenrouter/auto | Auto Route' },
  { key: 'ollama', name: '本地 Ollama', id: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: 'qwen3:14b | Qwen3 14B\nllama3.1:8b | Llama 3.1 8B', keyPh: '（本地服务通常留空）' },
];

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
          {(['general', 'models', 'frp', 'dsh', 'stats', 'hooks', 'about'] as Tab[]).map((x) => (
            <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
              {t(`settings.${x === 'models' || x === 'frp' ? x + 'Tab' : x}`)}
            </button>
          ))}
        </div>
        {tab === 'general' && <GeneralTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'frp' && <FrpTab />}
        {tab === 'dsh' && <DshTab />}
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
      </div>
    );
  }

  function ModelsTab() {
    return (
      <div className="settings-cards-col">
        <ProvidersCard />
        <BrowserCard />
        <CredsCard />
      </div>
    );
  }

  function FrpTab() {
    const [settings, setSettings] = useState<GatewaySettings | null>(null);
    useEffect(() => {
      fe.settings().then(setSettings);
    }, []);
    if (!settings) return <div style={{ color: 'var(--faint)' }}>{t('common.loading')}</div>;
    return (
      <div className="settings-cards-col">
        <FrpCard settings={settings} onChange={(patch) => setSettings({ ...settings, ...patch } as GatewaySettings)} />
        <div className="card frp-guide">
          <label>{t('frp.guideTitle')}</label>
          <p className="frp-intro">{t('frp.intro')}</p>
          <ol className="frp-steps">
            <li>{t('frp.step1')}</li>
            <li>{t('frp.step2')}</li>
            <li>{t('frp.step3')}</li>
            <li>{t('frp.step4')}</li>
            <li>{t('frp.step5')}</li>
          </ol>
          <div className="frp-links">
            <a href="https://github.com/fatedier/frp/releases" target="_blank" rel="noreferrer">
              <Icon name="download" size={12} /> frp 官方下载（GitHub Releases）
            </a>
            <a href="https://gh-proxy.com/https://github.com/fatedier/frp/releases" target="_blank" rel="noreferrer">
              <Icon name="download" size={12} /> 国内加速下载（GitHub 打不开时用）
            </a>
          </div>
          <p className="frp-note">{t('frp.note')}</p>
          <details className="frp-server-conf">
            <summary>{t('frp.serverConfTitle')}</summary>
            <pre>{t('frp.serverConf')}</pre>
          </details>
        </div>
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

  function BrowserCard() {    const [enabled, setEnabled] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      fe.browserStatus().then((r) => setEnabled(!!(r as any).enabled));
    }, []);
    return (
      <div className="card">
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('settings.browserTitle')}
            <span className={`dot ${enabled ? 'ok' : 'bad'}`} style={{ width: 8, height: 8, borderRadius: 4 }} />
            {enabled ? t('settings.browserOn') : t('settings.browserOff')}
          </label>
          <p style={{ fontSize: 12, color: 'var(--faint)', margin: '6px 0 10px' }}>{t('settings.browserHint')}</p>
          <button
            className={`btn sm ${enabled ? '' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await fe.browserToggle(!enabled);
              if (!r.ok) st.toast('error', (r as any).error || 'failed');
              else {
                const s = await fe.browserStatus();
                setEnabled(!!(s as any).enabled);
                st.toast('success', t('settings.browserApplied'));
              }
              setBusy(false);
            }}
          >
            {busy ? t('common.loading') : enabled ? t('settings.browserDisable') : t('settings.browserEnable')}
          </button>
        </div>
      </div>
    );
  }

  function ProvidersCard() {
    interface ProviderRow { id: string; name: string; models: number; keyRef?: string; keySet?: boolean }
    const [rows, setRows] = useState<ProviderRow[] | null>(null);
    const [form, setForm] = useState({ id: '', baseURL: '', apiKey: '', api: 'openai-completions', models: '' });
    const [busy, setBusy] = useState(false);
    const [keyEdit, setKeyEdit] = useState<string | null>(null);
    const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
    const [preset, setPreset] = useState<string>('');

    const applyPreset = (key: string) => {
      setPreset(key);
      if (key === 'custom') {
        setForm({ id: '', baseURL: '', apiKey: '', api: 'openai-completions', models: '' });
        return;
      }
      const p = LLM_PRESETS.find((x) => x.key === key);
      if (p) setForm({ id: p.id, baseURL: p.baseURL, apiKey: '', api: p.api, models: p.models });
    };

    const load = async () => {
      const provs = await dshCall<Array<{ id: string; name: string }>>('llm.listProviders', {});
      const cat = await dshCall<{ groups: Array<{ id: string; models: unknown[] }> }>('session.modelCatalog', {});
      const desc = await dshCall<{ namespaces: Array<{ ns: string; value: any }> }>('settings.describe', {});
      if (!provs.ok) return;
      const groups = cat.ok ? ((cat.value as any)?.groups || (cat.value as any)?.value?.groups || []) : [];
      const piNs = desc.ok ? (desc.value?.namespaces || []).find((n) => n.ns === 'llm-pi-ai') : undefined;
      const piProviders = (piNs?.value as any)?.providers || {};
      const refOf = (id: string) => (id === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : piProviders[id]?.apiKeyEnv) as string | undefined;
      const refs = (provs.value || []).map((p) => refOf(p.id)).filter(Boolean) as string[];
      const cd = refs.length ? await dshCall<Record<string, { configured: boolean }>>('credentials.describe', { refs }) : null;
      const cdMap = cd?.ok ? ((cd.value as any) || {}) : {};
      setRows((provs.value || []).map((p) => {
        const keyRef = refOf(p.id);
        return {
          id: p.id,
          name: p.name,
          models: groups.find((g: any) => g.id === p.id)?.models?.length || 0,
          keyRef,
          keySet: keyRef ? !!cdMap[keyRef]?.configured : undefined,
        };
      }));
    };

    useEffect(() => {
      void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const addProvider = async () => {
      const id = form.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!id || !form.baseURL.trim() || !form.models.trim()) return;
      setBusy(true);
      try {
        const keyRef = `${id.replace(/-/g, '_').toUpperCase()}_API_KEY`;
        // merge into the existing llm-pi-ai providers map (preserve siblings)
        const desc = await dshCall<{ namespaces: Array<{ ns: string; value: any; revision: number }> }>('settings.describe', {});
        const ns = desc.ok ? (desc.value?.namespaces || []).find((n) => n.ns === 'llm-pi-ai') : undefined;
        const cur = (ns?.value as any) || {};
        const models = form.models.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [mid, mname] = l.split('|').map((x) => x.trim());
          return { id: mid, name: mname || mid };
        });
        const providers = { ...(cur.providers || {}), [id]: { api: form.api, baseURL: form.baseURL.trim(), apiKeyEnv: keyRef, models } };
        const upd = await dshCall('settings.update', {
          ns: 'llm-pi-ai',
          patch: { ...cur, providers },
          expectedRevision: ns?.revision,
        });
        if (!upd.ok) {
          st.toast('error', upd.error?.message || 'settings.update failed');
          return;
        }
        if (form.apiKey.trim()) {
          const cs = await dshCall('credentials.set', { ref: keyRef, value: form.apiKey.trim() });
          if (!cs.ok) st.toast('error', cs.error?.message || 'credentials.set failed');
        }
        setForm({ id: '', baseURL: '', apiKey: '', api: 'openai-completions', models: '' });
        st.toast('success', t('settings.llmAdded'));
        await load();
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className="card">
        <div className="field">
          <label>{t('settings.llmTitle')}</label>
          <p style={{ fontSize: 12, color: 'var(--faint)', margin: '6px 0 10px' }}>{t('settings.llmHint')}</p>
          {rows === null && <div style={{ color: 'var(--faint)' }}>{t('common.loading')}</div>}
          {rows?.map((r) => (
            <div key={r.id} style={{ marginBottom: 6 }}>
              <div className="idle-row">
                <span className={`dot ${r.models > 0 ? 'ok' : 'bad'}`} style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{r.id}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                  {r.models} {t('settings.llmModels')}
                  {r.keyRef ? (r.keySet ? ` · ${t('settings.llmKeySet')}` : ` · ${t('settings.llmKeyMissing')}`) : ''}
                </span>
                {r.keyRef && (
                  <button className="btn sm" onClick={() => setKeyEdit(keyEdit === r.id ? null : r.id)}>
                    <Icon name="lock" size={11} /> {r.keySet ? t('settings.llmKeyChange') : t('settings.llmKeyAdd')}
                  </button>
                )}
              </div>
              {keyEdit === r.id && r.keyRef && (
                <div style={{ display: 'flex', gap: 8, padding: '6px 2px 2px 18px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{r.keyRef}</span>
                  <input
                    className="input"
                    type="password"
                    style={{ flex: '1 1 200px' }}
                    placeholder={t('settings.llmKeyPh')}
                    value={keyDraft[r.id] || ''}
                    onChange={(e) => setKeyDraft({ ...keyDraft, [r.id]: e.target.value })}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!(keyDraft[r.id] || '').trim()}
                    onClick={async () => {
                      const cs = await dshCall('credentials.set', { ref: r.keyRef, value: (keyDraft[r.id] || '').trim() });
                      if (cs.ok) {
                        setKeyDraft({ ...keyDraft, [r.id]: '' });
                        setKeyEdit(null);
                        st.toast('success', t('settings.llmKeySaved'));
                        await load();
                      } else st.toast('error', cs.error?.message || 'set failed');
                    }}
                  >
                    {t('common.save')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="field" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>{t('settings.llmAddTitle')}</label>
          <select className="input" style={{ marginBottom: 8 }} value={preset} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">{t('settings.llmPresetPh')}</option>
            {LLM_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
            <option value="custom">{t('settings.llmPresetOther')}</option>
          </select>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: '1 1 140px' }} placeholder={t('settings.llmIdPh')} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            <input className="input" style={{ flex: '2 1 240px' }} placeholder="https://api.example.com/v1" value={form.baseURL} onChange={(e) => setForm({ ...form, baseURL: e.target.value })} />
            <select className="input" style={{ flex: '0 1 200px' }} value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value })} title={t('settings.llmApiPh')}>
              <option value="openai-completions">OpenAI 兼容 (chat/completions)</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input className="input" type="password" style={{ flex: '1 1 180px' }} placeholder={t('settings.llmKeyPh')} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <textarea
            className="input mono"
            style={{ marginTop: 8, minHeight: 64, fontSize: 12 }}
            placeholder={t('settings.llmModelsPh')}
            value={form.models}
            onChange={(e) => setForm({ ...form, models: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn sm primary" disabled={busy || !form.id.trim() || !form.baseURL.trim() || !form.models.trim()} onClick={() => void addProvider()}>
              <Icon name="plus" size={12} /> {t('settings.llmAdd')}
            </button>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('settings.llmAddHint')}</span>
          </div>
        </div>
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

  function CredsCard() {
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
          <span className="badge">v0.2.0</span>
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
