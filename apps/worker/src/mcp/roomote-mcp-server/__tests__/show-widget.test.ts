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
  it('keeps static inline SVG chart primitives', async () => {
    const html = await sanitizeWidgetHtml(`
      <svg viewBox="0 0 200 100" role="img" aria-label="Bar chart">
        <defs>
          <linearGradient id="bar-gradient"><stop offset="0" stop-color="#38bdf8" /></linearGradient>
          <clipPath id="plot"><rect width="200" height="100" /></clipPath>
        </defs>
        <g clip-path="url(#plot)">
          <rect x="10" y="20" width="30" height="70" fill="url(#bar-gradient)" />
          <circle cx="80" cy="50" r="12" />
          <path d="M110 80 L140 30 L170 60" />
          <text x="10" y="15">Static chart</text>
        </g>
      </svg>
    `);

    expect(html).toContain('<svg');
    expect(html).toContain('<linearGradient');
    expect(html).toContain('<clipPath');
    expect(html).toContain('<rect');
    expect(html).toContain('<circle');
    expect(html).toContain('<path');
    expect(html).toContain('<text');
    expect(html).toContain('url(#bar-gradient)');
  });

  it('strips active SVG content and external references', async () => {
    const html = await sanitizeWidgetHtml(`
      <svg viewBox="0 0 100 100">
        <foreignObject><div>embedded HTML</div></foreignObject>
        <image href="https://evil.example/chart.svg" />
        <use href="https://evil.example/icons.svg#chart" />
        <animateTransform attributeName="transform" />
        <rect onclick="alert(1)" fill="url(https://evil.example/paint.svg#gradient)" />
        <a xlink:href="javascript:alert(1)"><text>bad link</text></a>
      </svg>
    `);

    expect(html).toContain('<svg');
    expect(html.toLowerCase()).not.toContain('foreignobject');
    expect(html).not.toContain('embedded HTML');
    expect(html.toLowerCase()).not.toContain('<image');
    expect(html.toLowerCase()).not.toContain('<use');
    expect(html.toLowerCase()).not.toContain('animatetransform');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html.toLowerCase()).not.toContain('xlink:href');
    expect(html.toLowerCase()).not.toContain('https://evil.example');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

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
