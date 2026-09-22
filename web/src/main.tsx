import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import './styles.css';

// surface runtime errors for debugging
function showErr(msg: string) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#7f1d1d;color:#fff;font:11px monospace;padding:8px;z-index:9999;white-space:pre-wrap;max-height:45vh;overflow:auto';
  div.textContent = msg;
  document.body.appendChild(div);
}
window.addEventListener('error', (e) => {
  showErr(`ERROR: ${e.message}\n${e.filename || ''}:${e.lineno || ''}\n${e.error?.stack || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  showErr(`UNHANDLED: ${e.reason?.message || e.reason}\n${e.reason?.stack || ''}`);
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
