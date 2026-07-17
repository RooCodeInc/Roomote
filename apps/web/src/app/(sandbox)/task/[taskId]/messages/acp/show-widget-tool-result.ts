import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

export const SHOW_WIDGET_TOOL_NAME = 'show_widget';

export const SHOW_WIDGET_DEFAULT_HEIGHT = 320;
export const SHOW_WIDGET_MIN_HEIGHT = 120;
export const SHOW_WIDGET_MAX_HEIGHT = 800;

export type ShowWidgetPayload = {
  title: string | null;
  html: string;
  css: string | null;
  height: number;
  textFallback: string | null;
};

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
export const SHOW_WIDGET_DEFAULT_CSS = `
:root {
  color-scheme: light dark;
  --rw-fg: #1c1917;
  --rw-muted: #57534e;
  --rw-border: #e7e5e4;
  --rw-bg: #ffffff;
  --rw-card: #fafaf9;
  --rw-accent: #0f766e;
  --rw-code-bg: #f5f5f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rw-fg: #f5f5f4;
    --rw-muted: #a8a29e;
    --rw-border: #44403c;
    --rw-bg: #1c1917;
    --rw-card: #292524;
    --rw-accent: #2dd4bf;
    --rw-code-bg: #292524;
  }
}
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--rw-fg);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}
body {
  padding: 12px 14px;
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
code, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
  background: var(--rw-code-bg);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
pre {
  background: var(--rw-code-bg);
  border: 1px solid var(--rw-border);
  border-radius: 8px;
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
  border: 1px solid var(--rw-border);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
th { background: var(--rw-card); font-weight: 600; }
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
.card, .panel {
  background: var(--rw-card);
  border: 1px solid var(--rw-border);
  border-radius: 10px;
  padding: 12px;
}
.muted { color: var(--rw-muted); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.badge {
  display: inline-block;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  padding: 0.1em 0.55em;
  font-size: 0.85em;
  color: var(--rw-muted);
}
`.trim();

export function buildShowWidgetSrcDoc(payload: ShowWidgetPayload): string {
  const styles = [SHOW_WIDGET_DEFAULT_CSS, payload.css ?? '']
    .filter((part) => part.trim().length > 0)
    .map((part) =>
      part
        .replace(/<\/?style\b[^>]*>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<\/?script\b[^>]*>/gi, ''),
    )
    .join('\n\n');

  const styleTag = `<style>${styles}</style>`;
  const title = payload.title
    ? `<title>${escapeHtmlText(payload.title)}</title>`
    : '';

  // If the model already gave a full document, inject styles into <head>.
  if (/<html[\s>]/i.test(payload.html)) {
    if (/<head[\s>]/i.test(payload.html)) {
      return payload.html.replace(
        /<head([^>]*)>/i,
        `<head$1>${title}${styleTag}`,
      );
    }

    return payload.html.replace(
      /<html([^>]*)>/i,
      `<html$1><head>${title}${styleTag}</head>`,
    );
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${title}${styleTag}</head><body>${payload.html}</body></html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#39;');
}
