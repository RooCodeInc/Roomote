import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

export const SHOW_WIDGET_TOOL_NAME = 'show_widget';
const ROOMOTE_MCP_SERVER_NAME = 'roomote';

const SHOW_WIDGET_DEFAULT_HEIGHT = 320;
const SHOW_WIDGET_MIN_HEIGHT = 120;
const SHOW_WIDGET_MAX_HEIGHT = 800;

export type ShowWidgetPayload = {
  title: string | null;
  html: string;
  css: string | null;
  height: number;
  textFallback: string | null;
};

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

const LIGHT_WIDGET_THEME: ShowWidgetHostTheme = {
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

const DARK_WIDGET_THEME: ShowWidgetHostTheme = {
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
  fontSans: LIGHT_WIDGET_THEME.fontSans,
  fontMono: LIGHT_WIDGET_THEME.fontMono,
};

function readHostValue(
  styles: CSSStyleDeclaration,
  property: string,
  fallback: string,
): string {
  return styles.getPropertyValue(property).trim() || fallback;
}

/**
 * Resolve the widget theme from the element that hosts the iframe. CSS custom
 * properties do not cross iframe boundaries, so the resolved values are copied
 * into the generated document.
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
    colorScheme === 'dark' ? DARK_WIDGET_THEME : LIGHT_WIDGET_THEME;

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

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapSuccessRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.success === true) {
    return record;
  }

  const nested = asRecord(record.result) ?? asRecord(record.data);
  return nested?.success === true ? nested : null;
}

function getMcpToolName(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
): string | null {
  return (
    asNonEmptyString(data.mcpToolName) ??
    asNonEmptyString(data.toolName) ??
    null
  );
}

function getMcpServerName(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
): string | null {
  const raw =
    asNonEmptyString(data.mcpServerName) ?? asNonEmptyString(data.serverName);
  return raw ? raw.toLowerCase() : null;
}

function isRoomoteMcpServer(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
): boolean {
  return getMcpServerName(data) === ROOMOTE_MCP_SERVER_NAME;
}

function clampWidgetHeight(height: unknown): number {
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    return SHOW_WIDGET_DEFAULT_HEIGHT;
  }

  const rounded = Math.round(height);
  return Math.min(
    SHOW_WIDGET_MAX_HEIGHT,
    Math.max(SHOW_WIDGET_MIN_HEIGHT, rounded),
  );
}

function parseShowWidgetPayload(value: unknown): ShowWidgetPayload | null {
  const record = unwrapSuccessRecord(value);
  if (!record) {
    return null;
  }

  const html = asNonEmptyString(record.html);
  if (!html) {
    return null;
  }

  if (record.shown !== true && record.success !== true) {
    return null;
  }

  return {
    title: asNonEmptyString(record.title),
    html,
    css: asNonEmptyString(record.css),
    height: clampWidgetHeight(record.height),
    textFallback: asNonEmptyString(record.textFallback),
  };
}

function isSettledToolResult(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): msg is AcpToolResultUiMessage {
  return (
    msg.kind === 'tool_result' &&
    !msg.partial &&
    msg.data.status !== 'failed' &&
    msg.data.status !== 'in_progress'
  );
}

/**
 * Extract a first-party `show_widget` payload from a successful settled tool
 * result. Only rendered HTML that passed server-side sanitization is shown;
 * in-progress or failed calls should not partial-render unsanitized rawInput.
 */
export function resolveShowWidgetForToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): ShowWidgetPayload | null {
  if (msg.data.isMcp !== true) {
    return null;
  }

  if (!isRoomoteMcpServer(msg.data)) {
    return null;
  }

  const toolName = getMcpToolName(msg.data);
  if (toolName !== SHOW_WIDGET_TOOL_NAME) {
    return null;
  }

  if (!isSettledToolResult(msg)) {
    return null;
  }

  const output = asNonEmptyString(msg.data.output);
  const text = asNonEmptyString(msg.text);

  for (const candidate of [output, text]) {
    if (!candidate) {
      continue;
    }

    const parsed = parseShowWidgetPayload(tryParseJson(candidate));
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/**
 * Default stylesheet injected around model HTML so unstyled fragments still
 * look reasonable inside the dark/light task UI.
 */
const SHOW_WIDGET_DEFAULT_CSS = `
:root {
  --rw-background: #ffffff;
  --rw-surface: #fafaf9;
  --rw-surface-muted: #f5f5f4;
  --rw-text: #1c1917;
  --rw-text-muted: #57534e;
  --rw-border: #e7e5e4;
  --rw-primary: #1c1917;
  --rw-primary-foreground: #ffffff;
  --rw-accent: #0f766e;
  --rw-success: #0f766e;
  --rw-warning: #b45309;
  --rw-danger: #dc2626;
  --rw-code-background: #f5f5f4;
  --rw-radius-sm: 0.2rem;
  --rw-radius-md: 0.3rem;
  --rw-radius-lg: 0.55rem;
  --rw-font-sans: ui-sans-serif, system-ui, sans-serif;
  --rw-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --rw-space-1: 0.25rem;
  --rw-space-2: 0.5rem;
  --rw-space-3: 0.75rem;
  --rw-space-4: 1rem;
  --rw-space-6: 1.5rem;

  /* Backward-compatible aliases for widgets created before the theme API. */
  --rw-fg: var(--rw-text);
  --rw-muted: var(--rw-text-muted);
  --rw-bg: var(--rw-background);
  --rw-card: var(--rw-surface);
  --rw-code-bg: var(--rw-code-background);
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--rw-text);
  font: 14px/1.5 var(--rw-font-sans);
}
body {
  padding: var(--rw-space-4);
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0 0 0.6em;
  line-height: 1.25;
  font-weight: 600;
}
h1 { font-size: 1.35rem; }
h2 { font-size: 1.2rem; }
h3 { font-size: 1.05rem; }
p, ul, ol, pre, table, blockquote {
  margin: 0 0 0.75em;
}
ul, ol { padding-left: 1.25em; }
a { color: var(--rw-accent); }
hr { border: 0; border-top: 1px solid var(--rw-border); margin: var(--rw-space-4) 0; }
code, kbd, samp {
  font-family: var(--rw-font-mono);
  font-size: 0.9em;
  background: var(--rw-code-background);
  border-radius: var(--rw-radius-sm);
  padding: 0.1em 0.35em;
}
pre {
  background: var(--rw-code-background);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: 10px 12px;
  overflow: auto;
}
pre code {
  background: transparent;
  padding: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95em;
}
th, td {
  border-bottom: 1px solid var(--rw-border);
  padding: var(--rw-space-2) var(--rw-space-3);
  text-align: left;
  vertical-align: top;
}
th { color: var(--rw-text-muted); font-size: 0.85em; font-weight: 600; }
blockquote {
  border-left: 3px solid var(--rw-border);
  margin-left: 0;
  padding: 0.2em 0 0.2em 0.9em;
  color: var(--rw-muted);
}
img, svg, video {
  max-width: 100%;
  height: auto;
}
.rw-stack { display: flex; flex-direction: column; gap: var(--rw-space-3); }
.rw-row, .row {
  display: flex;
  gap: var(--rw-space-2);
  flex-wrap: wrap;
  align-items: center;
}
.rw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
  gap: var(--rw-space-3);
}
.rw-card, .card, .panel {
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: var(--rw-space-4);
}
.rw-muted, .muted { color: var(--rw-text-muted); }
.rw-kicker {
  color: var(--rw-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rw-badge, .badge {
  display: inline-block;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  padding: 0.1em 0.55em;
  font-size: 0.85em;
  color: var(--rw-text-muted);
  background: var(--rw-surface-muted);
}
.rw-badge--accent { color: var(--rw-accent); border-color: var(--rw-accent); }
.rw-badge--success { color: var(--rw-success); border-color: var(--rw-success); }
.rw-badge--warning { color: var(--rw-warning); border-color: var(--rw-warning); }
.rw-badge--danger { color: var(--rw-danger); border-color: var(--rw-danger); }
.rw-stat {
  display: flex;
  min-height: 88px;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--rw-space-2);
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  padding: var(--rw-space-4);
}
.rw-stat__label { color: var(--rw-text-muted); font-size: 0.85em; }
.rw-stat__value { font-size: 1.5rem; font-weight: 650; line-height: 1.1; }
.rw-callout {
  border-left: 3px solid var(--rw-accent);
  background: var(--rw-surface-muted);
  border-radius: var(--rw-radius-md);
  padding: var(--rw-space-3) var(--rw-space-4);
}
.rw-callout--success { border-left-color: var(--rw-success); }
.rw-callout--warning { border-left-color: var(--rw-warning); }
.rw-callout--danger { border-left-color: var(--rw-danger); }
.rw-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2rem;
  border: 1px solid var(--rw-primary);
  border-radius: var(--rw-radius-md);
  padding: var(--rw-space-2) var(--rw-space-3);
  color: var(--rw-primary-foreground);
  background: var(--rw-primary);
  font: 600 0.9rem/1 var(--rw-font-sans);
}
`.trim();

function sanitizeCssValue(value: string): string {
  return value.replace(/[<>{};]/g, '').trim();
}

function buildHostThemeCss(theme: ShowWidgetHostTheme): string {
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

export function buildShowWidgetSrcDoc(
  payload: ShowWidgetPayload,
  theme: ShowWidgetHostTheme = LIGHT_WIDGET_THEME,
): string {
  const styles = [
    SHOW_WIDGET_DEFAULT_CSS,
    buildHostThemeCss(theme),
    payload.css ?? '',
  ]
    .filter((part) => part.trim().length > 0)
    .map((part) => part.replace(/[<>]/g, ''))
    .join('\n\n');

  const styleTag = `<style>${styles}</style>`;
  // Block all network access from the widget document: no remote images,
  // stylesheets, fonts, XHR, or framing. Only inline styles and empty defaults.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none';">`;
  const title = payload.title
    ? `<title>${escapeHtmlText(payload.title)}</title>`
    : '';
  const headBits = `${csp}${title}${styleTag}`;

  // Always wrap as a full document we fully control. Do not inject into
  // attacker-supplied <html>/<head> shells that could reintroduce remote loads.
  return `<!DOCTYPE html><html data-theme="${theme.colorScheme}"><head><meta charset="utf-8">${headBits}</head><body>${payload.html}</body></html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#39;');
}
