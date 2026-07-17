import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

import { replyToChatThread } from './chat-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const SHOW_WIDGET_MAX_HTML_CHARS = 100_000;
const SHOW_WIDGET_MAX_CSS_CHARS = 50_000;
const SHOW_WIDGET_MAX_TITLE_CHARS = 200;
const SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS = 4_000;
export const SHOW_WIDGET_DEFAULT_HEIGHT = 320;
export const SHOW_WIDGET_MIN_HEIGHT = 120;
export const SHOW_WIDGET_MAX_HEIGHT = 800;

type ShowWidgetInput = {
  html: string;
  title?: string;
  css?: string;
  height?: number;
  textFallback?: string;
};

type ShowWidgetSuccess = {
  success: true;
  shown: true;
  title: string | null;
  html: string;
  css: string | null;
  height: number;
  textFallback: string | null;
  chatFallbackPosted: boolean;
  chatFallbackMessageTs: string | null;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasChatFallbackSurface(): boolean {
  if (process.env.ROOMOTE_SLACK_CHANNEL?.trim()) {
    return true;
  }

  return (
    Boolean(process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim()) &&
    Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim())
  );
}

let purifier: ReturnType<typeof createDOMPurify> | null = null;

function getPurifier() {
  if (purifier) {
    return purifier;
  }

  const window = new JSDOM('').window;
  purifier = createDOMPurify(window);

  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName.toLowerCase();

    if (
      name.startsWith('on') ||
      name === 'srcdoc' ||
      name === 'formaction' ||
      name === 'xlink:href'
    ) {
      data.keepAttr = false;
      return;
    }

    if (
      name === 'href' ||
      name === 'src' ||
      name === 'poster' ||
      name === 'action' ||
      name === 'srcset'
    ) {
      const value = String(data.attrValue ?? '')
        .trim()
        .toLowerCase();

      if (
        value.startsWith('http:') ||
        value.startsWith('https:') ||
        value.startsWith('//') ||
        value.startsWith('javascript:') ||
        value.startsWith('vbscript:') ||
        value.startsWith('data:') ||
        value.startsWith('blob:')
      ) {
        data.keepAttr = false;
      }
    }
  });

  return purifier;
}

/**
 * Sanitize model HTML with a parser-backed allowlist (DOMPurify + JSDOM).
 * Regex multi-pass deletion is intentionally avoided because nested tags can
 * reconstitute blocked markup across passes.
 */
export function sanitizeWidgetHtml(html: string): string {
  return getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'base',
      'meta',
      'link',
      'style',
      'svg',
      'math',
      'noscript',
      'template',
      'video',
      'audio',
      'source',
      'track',
      'portal',
      'frame',
      'frameset',
      'applet',
    ],
    ALLOW_DATA_ATTR: false,
    FORBID_CONTENTS: ['script', 'style'],
  });
}

/**
 * Allow only local stylesheet declarations. Strip network-capable constructs
 * and any markup that could break out of a <style> element.
 */
export function sanitizeWidgetCss(css: string): string {
  let sanitized = css;

  // Remove HTML angle brackets so style content cannot inject tags.
  sanitized = sanitized.replace(/[<>]/g, '');

  // No remote stylesheet imports.
  sanitized = sanitized.replace(/@import\b[\s\S]*?(;|$)/gi, '');

  // Legacy CSS attack surfaces.
  sanitized = sanitized.replace(
    /(expression|behavior)\s*\([^)]*\)/gi,
    '/* blocked */',
  );
  sanitized = sanitized.replace(/-moz-binding\s*:[^;]+;?/gi, '');

  // Block network, data, and scripted urls in CSS.
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)\s*(?:https?:|\/\/|data:|javascript:|vbscript:|blob:)/gi,
    'url($1#blocked:',
  );

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

export async function handleShowWidget(
  params: ShowWidgetInput,
  options?: {
    roomoteConfig?: RoomoteConfig | null;
  },
): Promise<ToolResult> {
  try {
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
        'html is empty after sanitization; provide safe non-script markup to display',
      );
    }

    let chatFallbackPosted = false;
    let chatFallbackMessageTs: string | null = null;

    // When a chat surface exists, deliver the plain-text fallback so Slack /
    // Telegram / etc. still see the widget content that cannot render HTML.
    if (textFallback && hasChatFallbackSurface() && options?.roomoteConfig) {
      const message = title ? `*${title}*\n\n${textFallback}` : textFallback;
      const reply = await replyToChatThread(options.roomoteConfig, {
        text: message,
      });
      chatFallbackPosted = true;
      chatFallbackMessageTs = reply.messageTs ?? null;
    }

    const payload: ShowWidgetSuccess = {
      success: true,
      shown: true,
      title,
      html,
      css,
      height,
      textFallback,
      chatFallbackPosted,
      chatFallbackMessageTs,
    };

    return successResult(payload);
  } catch (error) {
    return catchError(error);
  }
}
