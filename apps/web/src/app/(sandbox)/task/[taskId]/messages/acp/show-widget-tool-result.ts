import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { SHOW_WIDGET_DEFAULT_CSS } from './show-widget-styles';
import {
  buildShowWidgetHostThemeCss,
  DEFAULT_SHOW_WIDGET_HOST_THEME,
  type ShowWidgetHostTheme,
} from './show-widget-theme';

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

function isTrustedRoomoteWidgetTool(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
): boolean {
  return (
    (data.isMcp === true && isRoomoteMcpServer(data)) ||
    (data.isMcp === false && data.isRoomoteNativeTool === true)
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
  if (!isTrustedRoomoteWidgetTool(msg.data)) {
    return null;
  }

  if (getMcpToolName(msg.data) !== SHOW_WIDGET_TOOL_NAME) {
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

export function buildShowWidgetSrcDoc(
  payload: ShowWidgetPayload,
  theme: ShowWidgetHostTheme = DEFAULT_SHOW_WIDGET_HOST_THEME,
): string {
  const styles = [
    SHOW_WIDGET_DEFAULT_CSS,
    buildShowWidgetHostThemeCss(theme),
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
