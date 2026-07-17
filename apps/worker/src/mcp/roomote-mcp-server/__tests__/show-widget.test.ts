import {
  clampWidgetHeight,
  handleShowWidget,
  sanitizeWidgetCss,
  sanitizeWidgetHtml,
  SHOW_WIDGET_DEFAULT_HEIGHT,
  SHOW_WIDGET_MAX_HEIGHT,
  SHOW_WIDGET_MIN_HEIGHT,
} from '../show-widget.js';

function parseResult(result: { content: Array<{ text?: string }> }) {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('handleShowWidget', () => {
  it('returns sanitized HTML with defaults', async () => {
    const result = await handleShowWidget({
      html: '<h1 onclick="alert(1)">Hello</h1><script>alert(2)</script>',
      title: 'Demo',
    });

    const parsed = parseResult(result);

    expect(parsed.success).toBe(true);
    expect(parsed.shown).toBe(true);
    expect(parsed.title).toBe('Demo');
    expect(parsed.height).toBe(SHOW_WIDGET_DEFAULT_HEIGHT);
    expect(String(parsed.html)).toContain('<h1>Hello</h1>');
    expect(String(parsed.html)).not.toContain('onclick');
    expect(String(parsed.html)).not.toContain('script');
    expect(parsed.textFallback).toBeNull();
  });

  it('does not reconstitute blocked tags through nested multi-character payloads', async () => {
    const result = await handleShowWidget({
      html: '<scr<script>ipt>alert(1)</script><if<iframe>rame src="https://evil"></iframe>',
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(String(parsed.html).toLowerCase()).not.toContain('<script');
    expect(String(parsed.html).toLowerCase()).not.toContain('<iframe');
  });

  it('clamps height and sanitizes CSS', async () => {
    const result = await handleShowWidget({
      html: '<p>hi</p>',
      height: 10_000,
      css: '@import url("https://evil.example/x.css"); body { color: red; background: url(https://evil.example/x.png); }',
    });

    const parsed = parseResult(result);

    expect(parsed.height).toBe(SHOW_WIDGET_MAX_HEIGHT);
    expect(String(parsed.css)).not.toContain('@import');
    expect(String(parsed.css)).not.toContain('https://evil');
    expect(String(parsed.css)).toContain('color: red');
  });

  it('rejects empty html', async () => {
    const result = await handleShowWidget({ html: '   ' });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('html is required');
  });

  it('rejects title that is too long', async () => {
    const result = await handleShowWidget({
      html: '<p>hi</p>',
      title: 'x'.repeat(201),
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('title exceeds');
  });

  it('strips style tag breakout attempts from CSS', () => {
    const css = sanitizeWidgetCss(
      '</style><script>alert(1)</script><style>p{color:red}',
    );
    expect(css).not.toContain('<');
    expect(css).not.toContain('>');
    expect(css).toContain('p{color:red}');
  });

  it('returns textFallback for the runtime delivery layer', async () => {
    const result = await handleShowWidget({
      html: '<p>ok</p>',
      title: 'Plan',
      textFallback: 'Plan fallback for chat',
    });

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.textFallback).toBe('Plan fallback for chat');
  });
});

describe('show-widget helpers', () => {
  it('strips javascript urls and nested frames', async () => {
    const html = await sanitizeWidgetHtml(
      '<a href="javascript:alert(1)">x</a><iframe src="https://evil"></iframe><img src="https://evil/x.png">',
    );
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('https://evil');
  });

  it('clamps height bounds', () => {
    expect(clampWidgetHeight(undefined)).toBe(SHOW_WIDGET_DEFAULT_HEIGHT);
    expect(clampWidgetHeight(1)).toBe(SHOW_WIDGET_MIN_HEIGHT);
    expect(clampWidgetHeight(5000)).toBe(SHOW_WIDGET_MAX_HEIGHT);
    expect(clampWidgetHeight(240)).toBe(240);
  });

  it('blocks CSS imports and remote urls', () => {
    const css = sanitizeWidgetCss(
      '@import "x"; p{color:blue; background:url("https://x");}',
    );
    expect(css).not.toContain('@import');
    expect(css).not.toContain('https://x');
    expect(css).toContain('color:blue');
  });
});
