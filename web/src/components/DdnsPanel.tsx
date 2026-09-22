// mainland-first fixed-domain route: ¥10/yr domain + DNSPod + home IPv6.
// The user pastes a DNSPod token; the gateway creates/updates the DNS record
// and keeps it fresh, so the home address stays fixed as the IP changes.

import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

function SubStep({ n, title, children }: { n: string; title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--dim)' }}>{n}. {title}</div>
      {children}
    </div>
  );
}

export function DdnsPanel({ v6, onHost }: { v6: string; onHost: (url: string) => void }) {
  const { t } = useI18n();
  const st = useStore();
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const [sub, setSub] = useState('dsh');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; error?: string; fqdn?: string; v6?: string; v4?: string } | null>(null);

  const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + (localStorage.getItem('g4d_token') || '') };
  const save = (patch: Record<string, unknown>) => fetch('/api/fe/settings', { method: 'PUT', headers: auth, body: JSON.stringify(patch) });

  useEffect(() => {
    void fetch('/api/fe/ddns/status', { headers: auth }).then((x) => x.json()).then((j) => {
      if (j?.fqdn) {
        const [s2, ...rest] = j.fqdn.split('.');
        setSub(s2);
        setDomain(rest.join('.'));
      }
    }).catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bind = async (enable: boolean) => {
    setBusy(true);
    try {
      await save({ ddnsToken: token.trim(), ddnsDomain: domain.trim(), ddnsSub: sub.trim(), ddnsEnabled: enable });
      const r = await fetch('/api/fe/ddns/apply', { method: 'POST', headers: auth, body: '{}' }).then((x) => x.json());
      setRes(r);
      if (r.ok) {
        const url = `http://${r.fqdn}:7420`;
        onHost(url);
        st.toast('success', t('ddns.bound'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="zap" size={13} /> {t('ddns.title')}
      </div>
      <div className="hint" style={{ marginTop: 2 }}>{t('ddns.hint')}</div>

      <SubStep n="1" title={t('ddns.step1')}>
        <div className="hint">{t('ddns.step1Hint')}</div>
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => window.open('https://console.dnspod.cn/account/token/token', '_blank')}>DNSPod Token 页 ↗</button>
      </SubStep>
      <SubStep n="2" title={t('ddns.step2')}>
        <input className="input mono" style={{ marginTop: 4 }} placeholder="12345,xxxxxxxxxxxxxxxx" value={token} onChange={(e) => setToken(e.target.value.trim())} />
      </SubStep>
      <SubStep n="3" title={t('ddns.step3')}>
        <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
          <input className="input" style={{ flex: '0 0 90px' }} value={sub} onChange={(e) => setSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
          <span style={{ color: 'var(--faint)' }}>.</span>
          <input className="input" style={{ flex: 1 }} placeholder="example.com（你的域名）" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} />
        </div>
        {v6 && <div className="hint" style={{ marginTop: 4 }}>{t('ddns.v6Detected')}: <span className="mono">{v6}</span></div>}
        {!v6 && <div className="hint" style={{ marginTop: 4, color: 'var(--yellow)' }}>{t('ddns.noV6')}</div>}
      </SubStep>
      <SubStep n="4" title={t('ddns.step4')}>
        <button className="btn sm primary" disabled={busy || !token || !domain} onClick={() => void bind(true)}>
          {busy ? t('common.loading') : t('ddns.bindBtn')}
        </button>
        {res && (
          <div className="hint" style={{ marginTop: 6 }}>
            {res.ok
              ? `${t('ddns.resolved')} ${res.fqdn}（${res.error || t('ddns.updated')}）`
              : <span style={{ color: 'var(--red)' }}>{res.error}</span>}
          </div>
        )}
        {res?.ok && <div className="hint" style={{ marginTop: 4 }}>{t('ddns.autoNote')}</div>}
      </SubStep>
    </div>
  );
}
