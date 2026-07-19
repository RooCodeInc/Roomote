export type ShowWidgetHostTheme = {
  colorScheme: 'light' | 'dark';
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  codeBackground: string;
  radius: string;
  fontSans: string;
  fontMono: string;
};

export const DEFAULT_SHOW_WIDGET_HOST_THEME: ShowWidgetHostTheme = {
  colorScheme: 'light',
  background: '#ffffff',
  surface: '#fafaf9',
  surfaceMuted: '#f5f5f4',
  text: '#1c1917',
  textMuted: '#57534e',
  border: '#e7e5e4',
  primary: '#1c1917',
  primaryForeground: '#ffffff',
  accent: '#0f766e',
  success: '#0f766e',
  warning: '#b45309',
  danger: '#dc2626',
  codeBackground: '#f5f5f4',
  radius: '0.3rem',
  fontSans:
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const DARK_SHOW_WIDGET_HOST_THEME: ShowWidgetHostTheme = {
  colorScheme: 'dark',
  background: '#1c1c1b',
  surface: '#000000',
  surfaceMuted: '#292929',
  text: '#ffffff',
  textMuted: '#a3a3a3',
  border: '#737373',
  primary: '#d8fb2b',
  primaryForeground: '#000000',
  accent: '#d8fb2b',
  success: '#2bd1b6',
  warning: '#ecb63a',
  danger: '#de3d3d',
  codeBackground: '#292929',
  radius: '0.3rem',
  fontSans: DEFAULT_SHOW_WIDGET_HOST_THEME.fontSans,
  fontMono: DEFAULT_SHOW_WIDGET_HOST_THEME.fontMono,
};

function readHostValue(
  styles: CSSStyleDeclaration,
  property: string,
  fallback: string,
): string {
  return styles.getPropertyValue(property).trim() || fallback;
}

/**
 * Resolve Roomote's computed tokens at the element that hosts the iframe. CSS
 * custom properties do not cross iframe boundaries, so the resolved values
 * become the explicit theme contract for the generated document.
 */
export function readShowWidgetHostTheme(element: Element): ShowWidgetHostTheme {
  const styles = getComputedStyle(element);
  const documentElement = element.ownerDocument.documentElement;
  const body = element.ownerDocument.body;
  const colorScheme =
    styles.colorScheme === 'dark' ||
    element.closest('.dark') !== null ||
    documentElement.classList.contains('dark') ||
    body?.classList.contains('dark')
      ? 'dark'
      : 'light';
  const fallback =
    colorScheme === 'dark'
      ? DARK_SHOW_WIDGET_HOST_THEME
      : DEFAULT_SHOW_WIDGET_HOST_THEME;

  return {
    colorScheme,
    background: readHostValue(styles, '--background', fallback.background),
    surface: readHostValue(styles, '--card', fallback.surface),
    surfaceMuted: readHostValue(styles, '--muted', fallback.surfaceMuted),
    text: readHostValue(styles, '--foreground', fallback.text),
    textMuted: readHostValue(styles, '--muted-foreground', fallback.textMuted),
    border: readHostValue(styles, '--border', fallback.border),
    primary: readHostValue(styles, '--primary', fallback.primary),
    primaryForeground: readHostValue(
      styles,
      '--primary-foreground',
      fallback.primaryForeground,
    ),
    accent: readHostValue(styles, '--accent-foreground', fallback.accent),
    success: readHostValue(styles, '--chart-2', fallback.success),
    warning: readHostValue(styles, '--warning', fallback.warning),
    danger: readHostValue(styles, '--destructive', fallback.danger),
    codeBackground: readHostValue(styles, '--muted', fallback.codeBackground),
    radius: readHostValue(styles, '--radius', fallback.radius),
    fontSans: readHostValue(styles, '--font-sans', fallback.fontSans),
    fontMono: readHostValue(styles, '--font-mono', fallback.fontMono),
  };
}

function sanitizeCssValue(value: string): string {
  return value.replace(/[<>{};]/g, '').trim();
}

export function buildShowWidgetHostThemeCss(
  theme: ShowWidgetHostTheme,
): string {
  const token = (value: string) => sanitizeCssValue(value);

  return `:root {
  color-scheme: ${theme.colorScheme};
  --rw-background: ${token(theme.background)};
  --rw-surface: ${token(theme.surface)};
  --rw-surface-muted: ${token(theme.surfaceMuted)};
  --rw-text: ${token(theme.text)};
  --rw-text-muted: ${token(theme.textMuted)};
  --rw-border: ${token(theme.border)};
  --rw-primary: ${token(theme.primary)};
  --rw-primary-foreground: ${token(theme.primaryForeground)};
  --rw-accent: ${token(theme.accent)};
  --rw-success: ${token(theme.success)};
  --rw-warning: ${token(theme.warning)};
  --rw-danger: ${token(theme.danger)};
  --rw-code-background: ${token(theme.codeBackground)};
  --rw-radius-sm: max(0px, calc(${token(theme.radius)} - 2px));
  --rw-radius-md: ${token(theme.radius)};
  --rw-radius-lg: calc(${token(theme.radius)} + 4px);
  --rw-font-sans: ${token(theme.fontSans)};
  --rw-font-mono: ${token(theme.fontMono)};
}`;
}

export function getShowWidgetHostThemeKey(theme: ShowWidgetHostTheme): string {
  return JSON.stringify(theme);
}
