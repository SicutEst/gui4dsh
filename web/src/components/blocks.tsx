import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import { dshCall } from '../api';
import { Icon, type IconName } from './Icon';
import type { ChatItem } from '../store';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => {
            const child: any = Array.isArray(children) ? children[0] : children;
            const raw = extractText(child?.props?.children);
            return (
              <div className="code-wrap">
                <button className="copy-btn mono" onClick={() => navigator.clipboard?.writeText(raw)}>copy</button>
                <pre>{children}</pre>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function extractText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children !== undefined) return extractText(node.props.children);
  return '';
}

function CopyableCode({ code }: { code: string }) {
  const { t } = useI18n();
  return (
    <div className="code-wrap">
      <button className="copy-btn mono" onClick={() => navigator.clipboard?.writeText(code)}>{t('common.copy')}</button>
      <pre className="code-block">{code}</pre>
    </div>
  );
}

function toolIconFor(name: string): IconName {
  const base = name.split(/[./]/)[0];
  if (name.startsWith('mcp__')) return 'link';
  switch (base) {
    case 'bash': case 'pwsh': case 'shell': return 'terminal';
    case 'fs': case 'fs-search': return 'file';
    case 'web': return 'globe';
    case 'todo': return 'list';
    case 'subagent': return 'bot';
    case 'skill': return 'command';
    case 'goal': return 'flag';
    case 'workflow': return 'repeat' as IconName;
    case 'ask': return 'message';
    default:
      return name.includes('edit') || name.includes('write') || name.includes('fs') ? 'file' : 'wrench';
  }
}

export function ToolCard({ item }: { item: ChatItem }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const name = item.name || '?';
  const icon = toolIconFor(name);

  let argPreview = '';
  try {
    argPreview = item.arguments || '';
  } catch {
    argPreview = String(item.arguments);
  }

  const resultTexts: string[] = [];
  for (const b of item.result?.content || []) {
    if (b.type === 'text' && b.text) resultTexts.push(b.text);
    else if (b.type === 'tool-result') resultTexts.push(extractBlocks(b.content));
    else resultTexts.push(JSON.stringify(b).slice(0, 500));
  }
  const resultText = resultTexts.join('\n');
  const hasError = !!item.result?.error;

  const statusLabel = item.pending
    ? t('chat.toolRunning')
    : hasError
      ? `${t('chat.toolError')}${item.result?.error?.code ? ` (${item.result.error.code})` : ''}`
      : '✓';

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <Icon name={icon} size={14} />
        <span className="tool-name">{name}</span>
        <span className="tool-args-preview">{argPreview.replace(/\s+/g, ' ').slice(0, 120)}</span>
        <span className={`tool-status ${item.pending ? '' : hasError ? 'err' : 'done'}`}>{statusLabel}</span>
      </div>
      {open && (
        <div className="tool-detail">
          <div className="lbl">{t('chat.toolArgs')}</div>
          <CopyableCode code={prettyJson(item.arguments)} />
          {item.result && (
            <>
              <div className="lbl">{t('chat.toolResult')}</div>
              {resultText ? (
                <pre className="code-block" style={{ maxHeight: 320, overflow: 'auto' }}>{resultText.slice(0, 20_000)}</pre>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--faint)' }}>
                  {locale === 'zh' ? '（无文本输出）' : '(no textual output)'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function extractBlocks(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b: any) => (b.type === 'text' ? b.text || '' : JSON.stringify(b))).join('\n');
}

function prettyJson(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ReasoningBox({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <details className="reasoning" open={false}>
      <summary><Icon name="brain" size={12} /> {t('chat.reasoning')}</summary>
      <div className="r-body">{text}</div>
    </details>
  );
}

export function UserBubble({ item, sessionId }: { item: ChatItem; sessionId?: string }) {
  const { locale } = useI18n();
  const texts: string[] = [];
  const images: Array<{ name?: string; attachmentId?: string; data?: string; mediaType?: string }> = [];
  const files: Array<{ name?: string }> = [];
  for (const b of item.message?.content || []) {
    if (b.type === 'text' && b.text) texts.push(b.text);
    else if (b.type === 'image') {
      const img = b as any;
      images.push({ name: img.name || img.attachment?.name, attachmentId: img.attachment?.attachmentId, data: img.data, mediaType: img.mediaType || img.attachment?.mediaType });
    } else if (b.type === 'file') files.push({ name: (b as any).name });
  }
  return (
    <div className="msg-user-bubble" style={{ opacity: item.optimistic ? 0.65 : 1 }}>
      {texts.join('\n')}
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: texts.length ? 6 : 0 }}>
          {images.map((img, i) => (
            <HistoryImage key={i} img={img} sessionId={sessionId} locale={locale} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <span key={i} className="att-chip"><Icon name="file" size={11} /> <span>{f.name || (locale === 'zh' ? '文件' : 'file')}</span></span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One user-attached image; history refs lazy-load their bytes via session.attachment. */
function HistoryImage({ img, sessionId, locale }: { img: { name?: string; attachmentId?: string; data?: string; mediaType?: string }; sessionId?: string; locale: string }) {
  const [src, setSrc] = useState<string | null>(img.data && img.mediaType ? `data:${img.mediaType};base64,${img.data}` : null);
  useEffect(() => {
    if (src || !sessionId || !img.attachmentId) return;
    let alive = true;
    void dshCall<{ data: string; attachment?: { mediaType?: string } }>('session.attachment', { sessionId, attachmentId: img.attachmentId }).then((r) => {
      if (alive && r.ok && r.value?.data) {
        setSrc(`data:${r.value.attachment?.mediaType || img.mediaType || 'image/png'};base64,${r.value.data}`);
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!src) {
    return <span className="att-chip"><Icon name="eye" size={11} /> <span>{img.name || (locale === 'zh' ? '图片' : 'image')}</span></span>;
  }
  return <img src={src} alt={img.name || ''} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, border: '1px solid var(--border)' }} />;
}

export function ContextRow({ item }: { item: ChatItem }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const src = item.message?.source || {};
  const summary =
    src.form === 'notice' && src.summary
      ? src.summary
      : src.plugin
        ? `${locale === 'zh' ? '插件注入' : 'plugin'} · ${src.plugin}`
        : locale === 'zh' ? '系统上下文' : 'context';
  const text = (item.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return (
    <div className="context-row">
      <div className="c-title" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <Icon name="info" size={11} /> {summary.slice(0, 140)}
      </div>
      {open && text && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{text.slice(0, 4000)}</div>}
    </div>
  );
}

export function AssistantMessageView({ item, showReasoning }: { item: ChatItem; showReasoning: boolean }) {
  const blocks = (item.message?.content || []) as Array<{ type: string; text?: string }>;
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'reasoning' && showReasoning && b.text) {
      nodes.push(<ReasoningBox key={i} text={b.text} />);
    } else if (b.type === 'text' && b.text) {
      nodes.push(<Markdown key={i} text={b.text} />);
    }
    // tool-call blocks inside assembled messages are rendered via their own tool items
  }
  return <>{nodes}</>;
}

export function StreamingView({ item, showReasoning }: { item: ChatItem; showReasoning: boolean }) {
  const { t } = useI18n();
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < (item.parts || []).length; i++) {
    const p = item.parts![i];
    if (p.kind === 'reasoning' && showReasoning && p.text) {
      nodes.push(<ReasoningBox key={i} text={p.text} />);
    } else if (p.kind === 'text' && p.text) {
      nodes.push(<Markdown key={i} text={p.text} />);
    } else if (p.kind === 'tool-call') {
      nodes.push(
        <ToolCard
          key={i}
          item={{ kind: 'tool', seq: item.seq, name: p.name, arguments: p.args, pending: true }}
        />,
      );
    }
  }
  return (
    <>
      {nodes}
      <div className="typing"><span className="d" /><span className="d" /><span className="d" /></div>
    </>
  );
}
