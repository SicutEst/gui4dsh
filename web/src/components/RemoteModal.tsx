import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { SetupWizard } from './SetupWizard';
import type { GatewaySettings, PairingInfo } from '../types';

export function RemoteModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const st = useStore();
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [ext, setExt] = useState('');
  const [reveal, setReveal] = useState(false);
  const [pc, setPc] = useState<{ code: string | null; expiresAt: number } | null>(null);
  const [settings, setSettings] = useState<GatewaySettings | null>(null);

  const refreshCode = async () => {
    const r = await fe.newPaircode();
    setPc(r);
  };

  const load = () =>
    Promise.all([fe.pairing(), fe.paircode(), fe.settings()]).then(([p, code, s]) => {
      setPairing(p);
      setExt(p.externalUrl || '');
      setPc(code);
      setSettings(s);
    });
  useEffect(() => {
    void load();
  }, []);

  if (!pairing) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 420 }}>
          <h2><Icon name="phone" size={15} /> {t('settings.remote')}</h2>
          <div style={{ color: 'var(--faint)' }}>{t('common.loading')}</div>
        </div>
      </div>
    );
  }
  const base = pairing.externalUrl || pairing.lanUrls[0] || `${location.protocol}//${location.host}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>
          <Icon name="phone" size={15} /> {t('settings.remote')}
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}><Icon name="x" size={12} /> {t('common.close')}</button>
        </h2>

        {settings && (
          <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="shield" size={14} />
                {t('settings.remoteSwitch')}
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {settings.remoteEnabled ? t('settings.remoteOnHint') : t('settings.remoteOffHint')}
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.remoteEnabled}
                onChange={async (e) => {
                  const next = { ...settings, remoteEnabled: e.target.checked };
                  setSettings(next);
                  const saved = await fe.saveSettings({ remoteEnabled: e.target.checked });
                  setSettings(saved);
                  st.toast(e.target.checked ? 'success' : 'info', e.target.checked ? t('settings.remoteOn') : t('settings.remoteOff'));
                }}
              />
              <span className="track" />
            </label>
          </div>
        )}

        <div className="settings-cards2">
          <div className="card" style={{ marginBottom: 0 }}>
            <div className="qr-box" style={{ padding: 0 }}>
              <div className="qr-white">
                <QRCodeSVG value={`${base}/#token=${pairing.token}`} size={190} />
              </div>
              <div className="url">{base}/#token=••••••</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm" onClick={() => st.setQrModal(`${base}/#token=${pairing.token}`)}>{t('settings.showQR')}</button>
                <button className="btn sm" onClick={() => navigator.clipboard?.writeText(`${base}/#token=${pairing.token}`)}>{t('common.copy')}</button>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 0 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t('settings.paircode')}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div
                  className="mono"
                  style={{
                    fontSize: 24, letterSpacing: 9, fontWeight: 700, padding: '8px 14px',
                    background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, minWidth: 150,
                  }}
                >
                  {pc?.code || '······'}
                </div>
                <button className="btn" title={t('settings.paircodeRefresh')} onClick={() => void refreshCode()}><Icon name="refresh" size={13} /></button>
                <button className="btn sm" disabled={!pc?.code} onClick={() => pc?.code && navigator.clipboard?.writeText(pc.code)}>{t('common.copy')}</button>
              </div>
              <div className="hint">
                {pc?.code
                  ? t('settings.paircodeHint', { min: Math.max(0, Math.ceil(((pc.expiresAt || 0) - Date.now()) / 60000)) })
                  : t('settings.paircodeNone')}
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t('settings.token')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input mono" readOnly type={reveal ? 'text' : 'password'} value={pairing.token} onFocus={() => setReveal(true)} />
              <button className="btn" onClick={() => setReveal(!reveal)}><Icon name="eye" size={14} /></button>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!window.confirm(t('settings.regenerateConfirm'))) return;
                  await fe.resetToken();
                  await load();
                  st.toast('success', t('settings.regenerate'));
                }}
              >
                {t('settings.regenerate')}
              </button>
            </div>
            <div className="hint">{t('settings.tokenHint')}</div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t('settings.lanUrls')}</label>
            {pairing.lanUrls.map((u) => (
              <div key={u} className="kv">
                <span className="k mono" style={{ minWidth: 0, flex: 1 }}>{u}</span>
                <button className="btn sm" onClick={() => st.setQrModal(`${u}/#token=${pairing.token}`)}>QR</button>
              </div>
            ))}
            {pairing.lanUrls.length === 0 && <div className="hint">—</div>}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t('settings.externalUrl')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" placeholder="https://dsh.example.com" value={ext} onChange={(e) => setExt(e.target.value)} />
              <button
                className="btn primary"
                onClick={async () => {
                  await fe.saveSettings({ externalBaseUrl: ext.trim() });
                  await load();
                  st.toast('success', t('settings.dshSaved'));
                }}
              >
                {t('common.save')}
              </button>
            </div>
            <div className="hint">{t('settings.externalUrlHint')}</div>
          </div>
        </div>

<SetupWizard lanOk={pairing.lanUrls.length > 0} externalUrl={ext || pairing.externalUrl || ''} onSaved={load} />

        <div style={{ fontSize: 12, color: 'var(--yellow)', padding: '0 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="alert" size={13} /> {t('settings.security')}
        </div>
      </div>
    </div>
  );
}
