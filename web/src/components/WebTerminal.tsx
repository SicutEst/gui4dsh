import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getWs, onWsMessage, wsSend } from '../api';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface TermInfo {
  id: string;
  title: string;
  shell: { name: string };
  cwd: string;
  cols: number;
  rows: number;
  state: string;
  exitCode: number | null;
}

/** Interactive in-app terminal: xterm.js over the gateway WS terminal bridge. */
export function WebTerminalView({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [info, setInfo] = useState<TermInfo | null>(null);
  const [status, setStatus] = useState<'idle' | 'booting' | 'live' | 'dead'>('idle');

  // list existing terminals so re-attaching picks the same one
  const refreshList = async (): Promise<TermInfo[]> => {
    const { dshCall } = await import('../api');
    const r = await dshCall<{ terminals?: TermInfo[]; items?: TermInfo[] }>('terminal.list', { sessionId });
    return (r.value as any)?.terminals || (r.value as any)?.items || [];
  };

  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    let opened = false;

    (async () => {
      setStatus('booting');
      // lazy-import keeps xterm out of the first bundle
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;
      const term = new XTerm({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: '#16181d', foreground: '#d6dadd' },
      });
      const fit = new Fit();
      term.loadAddon(fit);
      termRef.current = term;
      fitRef.current = fit;
      if (hostRef.current) term.open(hostRef.current);
      try { fit.fit(); } catch { /* tiny host */ }

      const ws = getWs();
      let cols = term.cols || 80;
      let rows = term.rows || 24;
      // pick size from the host box
      if (hostRef.current) {
        cols = Math.max(20, Math.floor(hostRef.current.clientWidth / 9));
        rows = Math.max(8, Math.floor(hostRef.current.clientHeight / 18));
      }

      const off = onWsMessage((msg: any) => {
        if (msg.t === 'term:frame' && msg.sessionId === sessionId) {
          const f = msg.frame || {};
          if (f.type === 'snapshot') {
            term.write(f.screen || '');
            if (f.info) setInfo(f.info);
            setStatus('live');
          } else if (f.type === 'output') {
            term.write(f.data || '');
          } else if (f.type === 'state') {
            if (f.info) setInfo(f.info);
            if (f.info?.state === 'exited') setStatus('dead');
          }
        }
      });
      unsub = off;

      // reuse an existing terminal for this session or create one
      let existing: TermInfo | null = null;
      try {
        const list = await refreshList();
        existing = list.find((x) => x.state === 'running') || null;
      } catch { /* list may be unavailable */ }
      if (disposed) return;

      if (!existing) {
        const { dshCall } = await import('../api');
        const cr = await dshCall<TermInfo>('terminal.create', {
          agentId: sessionId,
          request: { id: 'web-' + Math.random().toString(36).slice(2, 8), cols, rows },
        });
        if (cr.ok && cr.value) {
          existing = cr.value;
          setInfo(cr.value);
        }
      }
      if (disposed) return;
      const liveId = existing?.id || 'main';
      if (existing) {
        setTermId(liveId);
        setInfo(existing);
      }
      if (!ws) { setStatus('dead'); return; }

      ws.send(JSON.stringify({ t: 'term:subscribe', sessionId, termId: liveId }));
      opened = true;

      // input rides the gateway bridge (the bridge owns the attachment id)
      term.onData((data) => {
        if (!opened) return;
        wsSend({ t: 'term:write', sessionId, termId: liveId, data });
      });
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
        try { fit.fit(); } catch { /* hidden */ }
      }) : null;
      if (ro && hostRef.current) ro.observe(hostRef.current);
      (term as any)._ro = ro;    })();

    return () => {
      disposed = true;
      unsub?.();
      try { (termRef.current as any)?._ro?.disconnect(); } catch { /* ignore */ }
      try { termRef.current?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const spawnNew = async () => {
    const { dshCall } = await import('../api');
    const cols = Math.max(20, Math.floor((hostRef.current?.clientWidth || 480) / 9));
    const rows = Math.max(8, Math.floor((hostRef.current?.clientHeight || 300) / 18));
    const cr = await dshCall<TermInfo>('terminal.create', {
      agentId: sessionId,
      request: { id: 'web-' + Math.random().toString(36).slice(2, 8), cols, rows },
    });
    if (cr.ok && cr.value) {
      const ws = getWs();
      ws?.send(JSON.stringify({ t: 'term:subscribe', sessionId, termId: cr.value.id }));
      setInfo(cr.value);
      setTermId(cr.value.id);
      setStatus('booting');
      termRef.current?.reset();
    }
  };

  return (
    <div className="wt">
      <div className="wt-bar">
        <Icon name="terminal" size={12} />
        <span className="wt-title">{info?.title || info?.shell?.name || 'terminal'}</span>
        <span className={`wt-state ${status === 'live' ? 'ok' : status === 'dead' ? 'err' : ''}`}>
          {status === 'live' ? t('term.live') : status === 'dead' ? t('term.exited') : t('term.booting')}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title={t('term.new')} onClick={() => void spawnNew()}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      <div className="wt-host" ref={hostRef} />
    </div>
  );
}
