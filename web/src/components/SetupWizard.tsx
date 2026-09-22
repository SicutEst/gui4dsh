// novice-friendly remote-access setup wizard: LAN → FRP tunnel → free domain
// + HTTPS. Every command block is personalized with the values the user has
// typed (server IP, ports, token, subdomain) so they can copy-paste verbatim.

import React, { useEffect, useState } from 'react';
import { fe } from '../api';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { CloudflarePanel } from './CloudflarePanel';
import { DdnsPanel } from './DdnsPanel';
import type { GatewaySettings } from '../types';

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function CopyBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [ok, setOk] = useState(false);
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <pre style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 34px 8px 10px', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{text}</pre>
      <button
        className="btn sm"
        style={{ position: 'absolute', top: 6, right: 6 }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          } catch { /* clipboard unavailable */ }
        }}
      >
        {ok ? '✓' : t('common.copy')}
      </button>
    </div>
  );
}

function StepDot({ state }: { state: boolean | null }) {
  return <span className={`dot ${state === true ? 'ok' : state === false ? 'bad' : 'warn'}`} style={{ width: 9, height: 9, borderRadius: 5, flexShrink: 0, marginTop: 4 }} />;
}

function SubStep({ n, title, children }: { n: string; title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--dim)' }}>{n}. {title}</div>
      {children}
    </div>
  );
}

/** Guided DuckDNS flow: open site, paste token, pick name, we bind + verify. */
function DuckDnsPanel({ defaultIp, defaultV6, onHost }: { defaultIp: string; defaultV6: string; onHost: (host: string) => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [target, setTarget] = useState<'server' | 'v6'>(defaultV6 && !defaultIp ? 'v6' : 'server');
  const [busy, setBusy] = useState(false);
  const [bind, setBind] = useState<{ ok: boolean; response?: string; error?: string } | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; a?: string[]; aaaa?: string[] } | null>(null);
  const host = name.trim() ? name.trim() + '.duckdns.org' : '';
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginTop: 6 }}>
      <SubStep n="1" title={t('duck.open')}>
        <div className="hint">{t('duck.openHint')}</div>
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => window.open('https://www.duckdns.org', '_blank')}>duckdns.org ↗</button>
      </SubStep>
      <SubStep n="2" title={t('duck.token')}>
        <input className="input mono" style={{ marginTop: 4 }} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={token} onChange={(e) => setToken(e.target.value.trim())} />
      </SubStep>
      <SubStep n="3" title={t('duck.name')}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input className="input" style={{ flex: 1 }} placeholder="zhangsan-dsh" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
          <span style={{ fontSize: 12, color: 'var(--faint)', whiteSpace: 'nowrap' }}>.duckdns.org</span>
        </div>
        {(defaultIp || defaultV6) && (
          <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="radio" checked={target === 'server'} onChange={() => setTarget('server')} />
              {t('duck.toServer')}{defaultIp ? '（' + defaultIp + '）' : ''}
            </label>
            {defaultV6 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="radio" checked={target === 'v6'} onChange={() => setTarget('v6')} />
                {t('duck.toV6')}
              </label>
            )}
          </div>
        )}
      </SubStep>
      <SubStep n="4" title={t('duck.bind')}>
        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
          <button
            className="btn sm primary"
            disabled={busy || !token || !host}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await fe.duckdnsBind(token, name.trim(), target === 'server' && defaultIp ? defaultIp : undefined, target === 'v6' && defaultV6 ? defaultV6 : undefined);
                setBind(r);
                if (r.ok) {
                  const c = await fe.duckdnsCheck(host);
                  setCheck(c);
                  if (c.ok) onHost(host);
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t('common.loading') : t('duck.bindBtn')}
          </button>
          {bind && <span className={'badge ' + (bind.ok ? 'green' : '')}>{bind.ok ? 'OK' : bind.error || bind.response}</span>}
        </div>
        {check && check.ok && (
          <div className="hint" style={{ marginTop: 4 }}>
            {t('duck.resolved')}: {(check.a || []).join(', ')} {(check.aaaa || []).join(', ')}
          </div>
        )}
      </SubStep>
    </div>
  );
}

export function SetupWizard({ lanOk, externalUrl, onSaved }: { lanOk: boolean; externalUrl: string; onSaved: () => void }) {
  const { t } = useI18n();
  const st = useStore();
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [frpRunning, setFrpRunning] = useState<boolean | null>(null);
  const [probe, setProbe] = useState<{ ok?: boolean; status?: number; ms?: number; https?: boolean; certDays?: number | null; error?: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeUrl, setProbeUrl] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [net, setNet] = useState<{ publicV6?: string; publicV4?: string; localV6?: string[]; gatewayPort?: number; reach?: { duckdns?: boolean; cloudflare?: boolean; github?: boolean } } | null>(null);
  const loadNet = async () => setNet(await fetch('/api/fe/netinfo', { headers: { authorization: `Bearer ${localStorage.getItem('g4d_token') || ''}` } }).then((x) => x.json()).catch(() => null));

  const reload = async () => {
    setSettings(await fe.settings());
    setFrpRunning((await fe.frpStatus()).running);
  };
  useEffect(() => {
    void reload();
    void loadNet();
    setProbeUrl(externalUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch: Partial<GatewaySettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    void fe.saveSettings(patch).then(onSaved);
  };

  const srv = settings?.frpServer || '';
  const srvPort = settings?.frpServerPort || '7000';
  const remotePort = String(settings?.frpRemotePort ?? '');
  const token = settings?.frpToken || '';
  const dom = (subdomain || 'your-name').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const httpsPort = '7443';
  const finalUrl = dom && remotePort ? `https://${dom}:${httpsPort}` : '';

  const frpsBlock = srv
    ? `# 在云服务器的网页终端里逐条粘贴（云控制台点「远程连接」即可打开）\n# 1) 下载 frp\ncd /opt && wget https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz\ntar xzf frp_0.61.1_linux_amd64.tar.gz && mv frp_0.61.1_linux_amd64 frp && cd frp\n\n# 2) 写入配置（token 已帮你生成好）\ncat > frps.toml <<'EOF'\nbindPort = ${srvPort}\nauth.token = "${token || '先点上面的生成按钮'}"\nEOF\n\n# 3) 先手动启动一次（看到 "frps started" 即成功，Ctrl+C 停止）\n./frps -c frps.toml`
    : '';
  const frpsdBlock = srv
    ? `# 4) 设置开机自启（服务器重启后隧道自动恢复）\ncat > /etc/systemd/system/frps.service <<'EOF'\n[Unit]\nDescription=frps\nAfter=network.target\n\n[Service]\nExecStart=/opt/frp/frps -c /opt/frp/frps.toml\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\nEOF\nsystemctl daemon-reload && systemctl enable --now frps\n\n# 5) 在云厂商的「安全组/防火墙」里放行端口 ${srvPort} 和 ${remotePort || '远程端口'}（网页上点几下即可）`
    : '';
  const nginxBlock = dom && srv
    ? `# 在云服务器的网页终端里逐条粘贴\n# 1) 安装 nginx 和证书工具\napt update && apt install -y nginx certbot python3-certbot-nginx\n\n# 2) 反向代理配置（端口已填好）\ncat > /etc/nginx/conf.d/gui4dsh.conf <<'EOF'\nserver {\n  listen ${httpsPort};\n  server_name ${dom};\n  location / {\n    proxy_pass http://127.0.0.1:${remotePort || '远程端口'};\n    proxy_http_version 1.1;\n    proxy_set_header Upgrade \\$http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_read_timeout 3600s;\n  }\n}\nEOF\nnginx -t && systemctl reload nginx\n\n# 3) 放行端口 ${httpsPort}（云控制台安全组）\n\n# 4) 申请免费 HTTPS 证书（自动续期）\ncertbot --nginx -d ${dom} --redirect`
    : '';

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="sparkles" size={14} /> {t('wizard.title')}
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>{t('wizard.intro')}</div>

      {/* ---------- Step 1: LAN ---------- */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <StepDot state={lanOk} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>1. {t('wizard.step1')}</div>
          <div className="hint">{t('wizard.step1Hint')}</div>
        </div>
      </div>

      {/* ---------- zero-cost routes: no server needed ---------- */}
      <div className="card" style={{ marginBottom: 14, borderColor: 'var(--accent)' }}>
        <div style={{ fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="zap" size={14} /> {t('wizard.zeroTitle')}
        </div>
        <div className="hint" style={{ marginBottom: 8 }}>{t('wizard.zeroHint')}</div>
        {net?.reach && (!net.reach.duckdns || !net.reach.cloudflare) && (
          <div style={{ border: '1px solid var(--yellow)', background: 'var(--surface2)', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12, lineHeight: 1.8 }}>
            <div style={{ fontWeight: 600 }}>{t('reach.warnTitle')}</div>
            <div>{t('reach.warnBody')}</div>
          </div>
        )}
        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('reach.cnTitle')}</summary>
          <div className="hint" style={{ marginTop: 4, lineHeight: 1.8 }}>{t('reach.cnBody')}</div>
        </details>

        {/* route A: IPv6 direct */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{t('wizard.v6Title')}</div>
          <div className="hint" style={{ marginTop: 2 }}>{t('wizard.v6Hint')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn sm primary" onClick={() => void loadNet()}>{t('wizard.v6Detect')}</button>
            {net && (net.publicV6
              ? <span className="badge green">{t('wizard.v6Yes')}</span>
              : <span className="badge">{t('wizard.v6No')}</span>)}
          </div>
          {(net?.publicV6 || net) && (
          <DdnsPanel v6={net?.publicV6 || ''} onHost={(u) => { setProbeUrl(u); void fe.saveSettings({ externalBaseUrl: u }); onSaved(); }} />
        )}

        {net?.publicV6 && (
            <div style={{ marginTop: 8 }}>
              <div className="hint" style={{ wordBreak: 'break-all' }}>{t('wizard.v6Addr')}：<span className="mono">{net.publicV6}</span></div>
              <SubStep n="1" title={t('wizard.v6Step1')}><div className="hint">{t('wizard.v6Step1Hint')}</div></SubStep>
              <SubStep n="2" title={t('wizard.v6Step2')}><CopyBlock text={`# 电脑上以管理员打开 PowerShell，粘贴回车（放行 ${net.gatewayPort ?? 7420} 端口）\nnetsh advfirewall firewall add rule name="gui4dsh" dir=in action=allow protocol=TCP localport=${net.gatewayPort ?? 7420}`} /></SubStep>
              <SubStep n="3" title={t('wizard.v6Step3')}><div className="hint">{t('wizard.v6Step3Hint')}</div></SubStep>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: '1 1 150px' }} placeholder="https://你的名字.duckdns.org:7420" value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)} />
                <button className="btn sm" onClick={async () => {
                  setProbing(true);
                  try {
                    const r = await fetch('/api/fe/probe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('g4d_token') || ''}` }, body: JSON.stringify({ url: probeUrl.trim() }) }).then((x) => x.json());
                    setProbe(r);
                    if (r.ok) { await fe.saveSettings({ externalBaseUrl: probeUrl.trim() }); onSaved(); st.toast('success', t('wizard.probeOk')); }
                  } finally { setProbing(false); }
                }}>{t('wizard.probe')}</button>
              </div>
            </div>
          )}
        </div>

        <CloudflarePanel onExternalUrl={(u) => { setProbeUrl(u); void fe.saveSettings({ externalBaseUrl: u }); onSaved(); }} />
      </div>

      {/* ---------- Step 2: FRP ---------- */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <StepDot state={frpRunning} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            2. {t('wizard.step2')} {frpRunning ? <span className="badge green">{t('wizard.tunnelOn')}</span> : null}
          </div>
          <div className="hint">{t('wizard.step2Hint')}</div>

          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('wizard.noServer')}</summary>
            <div className="hint" style={{ marginTop: 4, lineHeight: 1.8 }}>
              {t('wizard.noServerHint')}
            </div>
          </details>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input className="input" style={{ flex: '1 1 140px' }} placeholder={t('wizard.serverIpPh')} value={srv} onChange={(e) => setSettings(settings ? { ...settings, frpServer: e.target.value } : settings)} onBlur={(e) => save({ frpServer: e.target.value })} />
            <input className="input" style={{ flex: '0 0 90px' }} placeholder="7000" value={srvPort} onChange={(e) => setSettings(settings ? { ...settings, frpServerPort: e.target.value } : settings)} onBlur={(e) => save({ frpServerPort: e.target.value })} />
            <input className="input" style={{ flex: '0 0 90px' }} placeholder={t('wizard.remotePortPh')} value={remotePort === '0' ? '' : remotePort} onChange={(e) => setSettings(settings ? { ...settings, frpRemotePort: e.target.value === '' ? undefined : Number(e.target.value) } : settings)} onBlur={(e) => save({ frpRemotePort: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input className="input mono" style={{ flex: 1 }} placeholder="Token" value={token} onChange={(e) => setSettings(settings ? { ...settings, frpToken: e.target.value } : settings)} onBlur={(e) => save({ frpToken: e.target.value })} />
            <button className="btn sm" title={t('wizard.genToken')} onClick={() => { const tk = genToken(); save({ frpToken: tk }); }}>🎲</button>
          </div>

          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('wizard.frpsHelp')}</summary>
            <SubStep n="a" title={t('wizard.frpsStepA')}><CopyBlock text={frpsBlock} /></SubStep>
            <SubStep n="b" title={t('wizard.frpsStepB')}><CopyBlock text={frpsdBlock} /></SubStep>
          </details>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button
              className="btn sm primary"
              onClick={async () => {
                const r = await fe.frpStart();
                if (!r.ok) st.toast('error', r.error || 'failed');
                await reload();
              }}
            >
              {t('settings.frpStart')}
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                await fe.frpStop();
                await reload();
              }}
            >
              {t('settings.frpStop')}
            </button>
            <span className="hint">{t('wizard.filledThenStart')}</span>
          </div>
        </div>
      </div>

      {/* ---------- Step 3: free domain + HTTPS ---------- */}
      <div style={{ display: 'flex', gap: 8 }}>
        <StepDot state={probe?.ok && probe.https ? true : probe ? false : null} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>3. {t('wizard.step3')}</div>
          <div className="hint">{t('wizard.step3Hint')}</div>

          <details style={{ marginTop: 6 }} open>
<summary style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('wizard.freeDomain')}</summary>
<DuckDnsPanel defaultIp={srv} defaultV6={net?.publicV6 || ''} onHost={(h) => { setSubdomain(h); setProbeUrl('https://' + h + ':' + httpsPort); }} />
</details>

          {dom && srv && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('wizard.nginxHelp')}</summary>
              <CopyBlock text={nginxBlock} />
            </details>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: '1 1 170px' }} placeholder={finalUrl || `https://${dom || 'your-name.duckdns.org'}:${httpsPort}`} value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)} />
            <button
              className="btn sm"
              disabled={probing || !probeUrl.trim()}
              onClick={async () => {
                setProbing(true);
                try {
                  const r = await fetch('/api/fe/probe', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('g4d_token') || ''}` },
                    body: JSON.stringify({ url: probeUrl.trim() }),
                  }).then((x) => x.json());
                  setProbe(r);
                  if (r.ok) {
                    await fe.saveSettings({ externalBaseUrl: probeUrl.trim() });
                    onSaved();
                    st.toast('success', t('wizard.probeOk'));
                  }
                } finally {
                  setProbing(false);
                }
              }}
            >
              {probing ? t('common.loading') : t('wizard.probe')}
            </button>
            {finalUrl && !probeUrl && <button className="btn sm" onClick={() => setProbeUrl(finalUrl)}>{t('wizard.fillUrl')}</button>}
          </div>
          {probe && (
            <div className="hint" style={{ marginTop: 6 }}>
              {probe.ok
                ? `${t('wizard.probeOk')} HTTP ${probe.status} · ${probe.ms}ms` + (probe.certDays != null ? ` · ${t('wizard.certDays')}: ${probe.certDays}d` : '')
                : `${t('wizard.probeFail')}: ${probe.error || ''}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
