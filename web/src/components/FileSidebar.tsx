import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

/** Right panel: lazy workspace file tree + plain-text preview (workspaceFiles RPC). */
export function FileSidebar(props: { sessionId: string }) {
  const { t, locale } = useI18n();
  const sid = props.sessionId;
  const listings = useStore((s) => s.fileListings);
  const preview = useStore((s) => s.filePreview);
  const st = useStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selPath, setSelPath] = useState<string | null>(null);

  useEffect(() => {
    if (listings[''] === undefined) void st.listFiles(sid, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const entries = listings[dir];
    if (!entries) return null;
    return entries.map((e) => {
      const child = join(dir, e.name);
      const isOpen = !!expanded[child];
      if (e.type === 'directory') {
        return (
          <div key={child}>
            <div
              className="fs-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                setExpanded((x) => ({ ...x, [child]: !x[child] }));
                if (!isOpen && listings[child] === undefined) void st.listFiles(sid, child);
              }}
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
              <Icon name="folder" size={12} />
              <span className="fs-name">{e.name}</span>
            </div>
            {isOpen && renderDir(child, depth + 1)}
          </div>
        );
      }
      return (
        <div
          key={child}
          className={`fs-row file ${selPath === child ? 'sel' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 + 13 }}
          title={child}
          onClick={() => {
            setSelPath(child);
            void st.openFilePreview(sid, child, e.size);
          }}
        >
          <Icon name="file" size={12} />
          <span className="fs-name">{e.name}</span>
          {typeof e.size === 'number' && <span className="fs-size">{fmtSize(e.size)}</span>}
        </div>
      );
    });
  };

  return (
    <div className="file-panel">
      <div className="fs-head">
        <Icon name="folder" size={13} />
        <span>{t('files.title')}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title={locale === 'zh' ? '刷新' : 'Refresh'} onClick={() => void st.listFiles(sid, '')}>
          <Icon name="refresh" size={13} />
        </button>
        <button className="icon-btn" title={t('common.close')} onClick={() => st.toggleFilePanel()}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="fs-tree">{renderDir('', 0)}</div>
      {preview && (
        <div className="fs-preview">
          <div className="fs-preview-head" title={preview.path}>
            <Icon name="eye" size={12} />
            <span className="fs-name">{preview.path.split(/[\\/]/).pop()}</span>
            {typeof preview.bytes === 'number' && <span className="fs-size">{fmtSize(preview.bytes)}</span>}
          </div>
          <div className="fs-preview-body">
            {preview.loading && <div className="fs-hint">{t('common.loading')}</div>}
            {preview.err && <div className="fs-hint err">{preview.err}</div>}
            {preview.text !== undefined && <pre>{preview.text}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
