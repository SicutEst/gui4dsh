// theme resolution: stored preference is light | dark | system; the DOM only
// ever receives a concrete data-theme so the CSS token sets stay binary

export function storedTheme(): string {
  return localStorage.getItem('g4d_theme') || 'light';
}

export function resolveTheme(theme: string): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

/** Re-resolve when the OS switches appearance while the app follows system. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (storedTheme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
