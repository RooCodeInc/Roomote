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
  it('returns sanitized HTML with defaults', () => {
    const result = handleShowWidget({
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
  });

  it('clamps height and sanitizes CSS', () => {
    const result = handleShowWidget({
      html: '<p>hi</p>',
      height: 10_000,
      css: '@import url("https://evil.example/x.css"); body { color: red; }',
    });

    const parsed = parseResult(result);

    expect(parsed.height).toBe(SHOW_WIDGET_MAX_HEIGHT);
    expect(String(parsed.css)).not.toContain('@import');
    expect(String(parsed.css)).toContain('color: red');
  });

  it('rejects empty html', () => {
    const result = handleShowWidget({ html: '   ' });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('html is required');
  });

  it('rejects title that is too long', () => {
    const result = handleShowWidget({
      html: '<p>hi</p>',
      title: 'x'.repeat(201),
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('title exceeds');
  });

  it('strips style tag breakout attempts from CSS', () => {
    expect(
      sanitizeWidgetCss('</style><script>alert(1)</script><style>p{color:red}'),
    ).toBe('p{color:red}');
  });
});

describe('show-widget helpers', () => {
  it('strips javascript urls and nested frames', () => {
    const html = sanitizeWidgetHtml(
      '<a href="javascript:alert(1)">x</a><iframe src="/y"></iframe>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('iframe');
    expect(html).toContain('#blocked:');
  });

  it('clamps height bounds', () => {
    expect(clampWidgetHeight(undefined)).toBe(SHOW_WIDGET_DEFAULT_HEIGHT);
    expect(clampWidgetHeight(1)).toBe(SHOW_WIDGET_MIN_HEIGHT);
    expect(clampWidgetHeight(5000)).toBe(SHOW_WIDGET_MAX_HEIGHT);
    expect(clampWidgetHeight(240)).toBe(240);
  });

  it('blocks CSS imports', () => {
    expect(sanitizeWidgetCss('@import "x"; p{color:blue}')).toBe(
      ' p{color:blue}',
    );
  });
});
