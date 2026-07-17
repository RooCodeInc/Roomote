import { successResult, errorResult } from './tool-result.js';
import type { ToolResult } from './types.js';

export const SHOW_WIDGET_MAX_HTML_CHARS = 100_000;
export const SHOW_WIDGET_MAX_CSS_CHARS = 50_000;
export const SHOW_WIDGET_MAX_TITLE_CHARS = 200;
export const SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS = 4_000;
export const SHOW_WIDGET_DEFAULT_HEIGHT = 320;
export const SHOW_WIDGET_MIN_HEIGHT = 120;
export const SHOW_WIDGET_MAX_HEIGHT = 800;

export type ShowWidgetInput = {
  html: string;
  title?: string;
  css?: string;
  height?: number;
  textFallback?: string;
};

export type ShowWidgetSuccess = {
  success: true;
  shown: true;
  title: string | null;
  html: string;
  css: string | null;
  height: number;
  textFallback: string | null;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strip the most dangerous HTML surfaces from model-generated widget content.
 * Defense-in-depth only: the task UI also mounts widgets in a sandboxed iframe
 * with scripts disabled.
 */
export function sanitizeWidgetHtml(html: string): string {
  let sanitized = html;

  // Remove whole script blocks, including content, case-insensitive.
  sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  sanitized = sanitized.replace(/<script\b[^>]*\/?>/gi, '');

  // Drop other active or nested browsing contexts.
  sanitized = sanitized.replace(
    /<(iframe|object|embed|applet|form|base|meta|link|frame|frameset)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  sanitized = sanitized.replace(
    /<(iframe|object|embed|applet|form|base|meta|link|frame|frameset)\b[^>]*\/?>/gi,
    '',
  );

  // Strip inline event handlers (onclick, onerror, ...).
  sanitized = sanitized.replace(
    /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  );

  // Neutralize javascript: and data: URLs in href/src/xlink:href/action/formaction.
  sanitized = sanitized.replace(
    /\s(href|src|xlink:href|action|formaction|poster)\s*=\s*(['"])\s*(javascript|vbscript|data)\s*:/gi,
    ' $1=$2#blocked:',
  );
  sanitized = sanitized.replace(
    /\s(href|src|xlink:href|action|formaction|poster)\s*=\s*(javascript|vbscript|data)\s*:/gi,
    ' $1=#blocked:',
  );

  return sanitized;
}

export function sanitizeWidgetCss(css: string): string {
  let sanitized = css;
  // Strip @import so external stylesheets cannot pull arbitrary network CSS.
  sanitized = sanitized.replace(/@import\b[^;]+;?/gi, '');
  // Strip behavior/expression and -moz-binding for legacy attack surfaces.
  sanitized = sanitized.replace(
    /(expression|behavior)\s*\([^)]*\)/gi,
    '/* blocked */',
  );
  sanitized = sanitized.replace(/-moz-binding\s*:[^;]+;?/gi, '');
  sanitized = sanitized.replace(
    /url\(\s*['"]?\s*javascript\s*:/gi,
    'url(#blocked:',
  );
  // Prevent breaking out of the injected <style> element, or smuggling HTML.
  sanitized = sanitized.replace(/<\/?style\b[^>]*>/gi, '');
  sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  sanitized = sanitized.replace(/<\/?script\b[^>]*>/gi, '');
  return sanitized;
}

export function clampWidgetHeight(height: number | undefined): number {
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    return SHOW_WIDGET_DEFAULT_HEIGHT;
  }

  const rounded = Math.round(height);
  return Math.min(
    SHOW_WIDGET_MAX_HEIGHT,
    Math.max(SHOW_WIDGET_MIN_HEIGHT, rounded),
  );
}

export function handleShowWidget(params: ShowWidgetInput): ToolResult {
  const rawHtml = asTrimmedString(params.html);
  if (!rawHtml) {
    return errorResult('html is required and must be a non-empty string');
  }

  if (rawHtml.length > SHOW_WIDGET_MAX_HTML_CHARS) {
    return errorResult(
      `html exceeds the maximum length of ${SHOW_WIDGET_MAX_HTML_CHARS} characters`,
    );
  }

  const rawCss = asTrimmedString(params.css);
  if (rawCss && rawCss.length > SHOW_WIDGET_MAX_CSS_CHARS) {
    return errorResult(
      `css exceeds the maximum length of ${SHOW_WIDGET_MAX_CSS_CHARS} characters`,
    );
  }

  const title = asTrimmedString(params.title);
  if (title && title.length > SHOW_WIDGET_MAX_TITLE_CHARS) {
    return errorResult(
      `title exceeds the maximum length of ${SHOW_WIDGET_MAX_TITLE_CHARS} characters`,
    );
  }

  const textFallback = asTrimmedString(params.textFallback);
  if (
    textFallback &&
    textFallback.length > SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS
  ) {
    return errorResult(
      `textFallback exceeds the maximum length of ${SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS} characters`,
    );
  }

  const html = sanitizeWidgetHtml(rawHtml);
  const css = rawCss ? sanitizeWidgetCss(rawCss) : null;
  const height = clampWidgetHeight(params.height);

  if (!html.trim()) {
    return errorResult(
      'html is empty after sanitization; provide non-script markup to display',
    );
  }

  const payload: ShowWidgetSuccess = {
    success: true,
    shown: true,
    title,
    html,
    css,
    height,
    textFallback,
  };

  return successResult(payload);
}
