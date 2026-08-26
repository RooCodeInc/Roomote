import type { DOMPurify } from 'dompurify';

export const SHOW_WIDGET_MAX_HTML_CHARS = 100_000;
export const SHOW_WIDGET_MAX_CSS_CHARS = 50_000;
export const SHOW_WIDGET_MAX_TITLE_CHARS = 200;
export const SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS = 4_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SHOW_WIDGET_DEFAULT_HEIGHT = 320;
export const SHOW_WIDGET_MIN_HEIGHT = 120;
export const SHOW_WIDGET_MAX_HEIGHT = 800;
export const SHOW_WIDGET_ESTIMATED_ROW_HEIGHT = 48;
export const SHOW_WIDGET_TABLE_MIN_HEIGHT = 480;
export const SHOW_WIDGET_SUMMARY_TABLE_MIN_HEIGHT = 560;
export const SHOW_WIDGET_THEME_GUIDANCE =
  'Prefer semantic HTML with the built-in widget classes (`rw-card`, `rw-stack`, `rw-row`, `rw-grid`, `rw-stat`, `rw-badge`, `rw-callout`, `rw-muted`) so the widget follows the host theme. For custom CSS, use the provided `--rw-*` theme variables instead of hard-coded colors; omit css when the built-in styles are sufficient.';
export const SHOW_WIDGET_HEIGHT_GUIDANCE = `Do not guess a tight height. Estimate the rendered height before calling the tool: include body padding, section padding and gaps, headings, and about ${SHOW_WIDGET_ESTIMATED_ROW_HEIGHT}px for each table or list row. Use at least ${SHOW_WIDGET_TABLE_MIN_HEIGHT}px for a table or list and ${SHOW_WIDGET_SUMMARY_TABLE_MIN_HEIGHT}-${SHOW_WIDGET_MAX_HEIGHT}px when summary cards or metrics appear above one. Add headroom; when uncertain, choose a taller canvas or reduce the content before calling the tool.`;
export const SHOW_WIDGET_HEIGHT_DESCRIPTION = `Optional fixed widget iframe height in pixels (clamped to ${SHOW_WIDGET_MIN_HEIGHT}-${SHOW_WIDGET_MAX_HEIGHT}; default ${SHOW_WIDGET_DEFAULT_HEIGHT}). ${SHOW_WIDGET_HEIGHT_GUIDANCE}`;
export const SHOW_WIDGET_FIXED_CANVAS_GUIDANCE = `Treat the widget width and declared height as a fixed canvas. The complete widget must fit within both dimensions without horizontal or vertical overflow. Never rely on scrollbars, clipping, \`overflow: auto\`, \`overflow: scroll\`, or content hidden below the fold. Use compact spacing, concise labels, and a small number of cards, rows, or table entries. ${SHOW_WIDGET_HEIGHT_GUIDANCE} Use ordinary prose or an artifact for long content.`;

export type ShowWidgetInput = {
  html: string;
  title?: string;
  css?: string;
  height?: number;
  textFallback?: string;
};

export type ShowWidgetResult =
  | {
      success: true;
      shown: true;
      title: string | null;
      html: string;
      css: string | null;
      height: number;
      textFallback: string | null;
    }
  | { success: false; error: string };

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

let purifierPromise: Promise<DOMPurify> | null = null;

async function getPurifier(): Promise<DOMPurify> {
  if (purifierPromise) {
    return purifierPromise;
  }

  purifierPromise = Promise.all([import('dompurify'), import('jsdom')]).then(
    ([{ default: createDOMPurify }, { JSDOM }]) => {
      const purifier = createDOMPurify(new JSDOM('').window);

      purifier.addHook('uponSanitizeAttribute', (node, data) => {
        const name = data.attrName.toLowerCase();
        const value = String(data.attrValue ?? '')
          .trim()
          .toLowerCase();

        if (
          name.startsWith('on') ||
          name === 'srcdoc' ||
          name === 'formaction' ||
          name === 'xlink:href'
        ) {
          data.keepAttr = false;
          return;
        }

        if (node.namespaceURI === SVG_NAMESPACE) {
          if (name === 'href' && !value.startsWith('#')) {
            data.keepAttr = false;
            return;
          }

          const withoutLocalReferences = value.replace(
            /url\(\s*(['"]?)#[^'"()\s]+\1\s*\)/gi,
            '',
          );
          if (/url\s*\(/i.test(withoutLocalReferences)) {
            data.keepAttr = false;
            return;
          }
        }

        if (
          name === 'href' ||
          name === 'src' ||
          name === 'poster' ||
          name === 'action' ||
          name === 'srcset'
        ) {
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
    },
  );

  return purifierPromise;
}

/** Sanitize model HTML with a parser-backed allowlist (DOMPurify + JSDOM). */
export async function sanitizeWidgetHtml(html: string): Promise<string> {
  const purifier = await getPurifier();

  return purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
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
      'math',
      'foreignobject',
      'image',
      'use',
      'animate',
      'animatecolor',
      'animatemotion',
      'animatetransform',
      'filter',
      'set',
      'mpath',
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
    ADD_FORBID_CONTENTS: ['script', 'style'],
  });
}

/** Allow only local stylesheet declarations and block network-capable CSS. */
export function sanitizeWidgetCss(css: string): string {
  let sanitized = css;

  sanitized = sanitized.replace(/[<>]/g, '');
  sanitized = sanitized.replace(/@import\b[\s\S]*?(;|$)/gi, '');
  sanitized = sanitized.replace(
    /(expression|behavior)\s*\([^)]*\)/gi,
    '/* blocked */',
  );
  sanitized = sanitized.replace(/-moz-binding\s*:[^;]+;?/gi, '');
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

export async function prepareShowWidget(
  params: ShowWidgetInput,
): Promise<ShowWidgetResult> {
  try {
    const rawHtml = asTrimmedString(params.html);
    if (!rawHtml) {
      return {
        success: false,
        error: 'html is required and must be a non-empty string',
      };
    }

    if (rawHtml.length > SHOW_WIDGET_MAX_HTML_CHARS) {
      return {
        success: false,
        error: `html exceeds the maximum length of ${SHOW_WIDGET_MAX_HTML_CHARS} characters`,
      };
    }

    const rawCss = asTrimmedString(params.css);
    if (rawCss && rawCss.length > SHOW_WIDGET_MAX_CSS_CHARS) {
      return {
        success: false,
        error: `css exceeds the maximum length of ${SHOW_WIDGET_MAX_CSS_CHARS} characters`,
      };
    }

    const title = asTrimmedString(params.title);
    if (title && title.length > SHOW_WIDGET_MAX_TITLE_CHARS) {
      return {
        success: false,
        error: `title exceeds the maximum length of ${SHOW_WIDGET_MAX_TITLE_CHARS} characters`,
      };
    }

    const textFallback = asTrimmedString(params.textFallback);
    if (
      textFallback &&
      textFallback.length > SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS
    ) {
      return {
        success: false,
        error: `textFallback exceeds the maximum length of ${SHOW_WIDGET_MAX_TEXT_FALLBACK_CHARS} characters`,
      };
    }

    const html = await sanitizeWidgetHtml(rawHtml);
    const css = rawCss ? sanitizeWidgetCss(rawCss) : null;

    if (!html.trim()) {
      return {
        success: false,
        error:
          'html is empty after sanitization; provide safe non-script markup to display',
      };
    }

    return {
      success: true,
      shown: true,
      title,
      html,
      css,
      height: clampWidgetHeight(params.height),
      textFallback,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
