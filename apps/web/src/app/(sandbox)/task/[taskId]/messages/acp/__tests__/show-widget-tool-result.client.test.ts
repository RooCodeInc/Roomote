import {
  buildShowWidgetSrcDoc,
  resolveShowWidgetForToolMessage,
  SHOW_WIDGET_TOOL_NAME,
} from '../show-widget-tool-result';
import type { ShowWidgetHostTheme } from '../show-widget-theme';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from '../types';

function buildResult(
  overrides?: Partial<AcpToolResultUiMessage['data']> & {
    text?: string;
  },
): AcpToolResultUiMessage {
  const { text, ...dataOverrides } = overrides ?? {};
  return {
    id: 'tool-result-1',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call_update',
    kind: 'tool_result',
    text: text ?? '',
    data: {
      toolCallId: 'call-1',
      kind: 'mcp',
      title: SHOW_WIDGET_TOOL_NAME,
      status: 'completed',
      isExecute: false,
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: SHOW_WIDGET_TOOL_NAME,
      serverName: 'roomote',
      toolName: SHOW_WIDGET_TOOL_NAME,
      command: null,
      exitCode: 0,
      output: '',
      ...dataOverrides,
    },
  };
}

function buildCall(
  overrides?: Partial<AcpToolCallUiMessage['data']>,
): AcpToolCallUiMessage {
  return {
    id: 'tool-call-1',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    kind: 'tool_call',
    text: SHOW_WIDGET_TOOL_NAME,
    data: {
      toolCallId: 'call-1',
      kind: 'mcp',
      title: SHOW_WIDGET_TOOL_NAME,
      status: 'in_progress',
      isExecute: false,
      isRead: false,
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: SHOW_WIDGET_TOOL_NAME,
      serverName: 'roomote',
      toolName: SHOW_WIDGET_TOOL_NAME,
      command: null,
      ...overrides,
    },
  };
}

describe('resolveShowWidgetForToolMessage', () => {
  it('parses settled show_widget results from the roomote MCP server', () => {
    const widget = resolveShowWidgetForToolMessage(
      buildResult({
        output: JSON.stringify({
          success: true,
          shown: true,
          title: 'Status',
          html: '<p>ok</p>',
          css: '.x{color:red}',
          height: 400,
          textFallback: 'ok',
        }),
      }),
    );

    expect(widget).toEqual({
      title: 'Status',
      html: '<p>ok</p>',
      css: '.x{color:red}',
      height: 400,
      textFallback: 'ok',
    });
  });

  it('ignores in-progress rawInput and only renders successful tool results', () => {
    const widget = resolveShowWidgetForToolMessage(
      buildCall({
        ...({
          rawInput: {
            html: '<table><tr><td>a</td></tr></table>',
            title: 'Diff',
          },
        } as Partial<AcpToolCallUiMessage['data']>),
      }),
    );

    expect(widget).toBeNull();
  });

  it('ignores failed tool results even if pure HTML is present in the text', () => {
    const widget = resolveShowWidgetForToolMessage(
      buildResult({
        status: 'failed',
        output: JSON.stringify({
          success: false,
          error: 'html is empty after sanitization',
        }),
        text: JSON.stringify({
          success: false,
          error: 'html is empty after sanitization',
        }),
      }),
    );

    expect(widget).toBeNull();
  });

  it('ignores show_widget results from non-roomote MCP servers', () => {
    const widget = resolveShowWidgetForToolMessage(
      buildResult({
        mcpServerName: 'evil-server',
        serverName: 'evil-server',
        output: JSON.stringify({
          success: true,
          shown: true,
          title: 'Nope',
          html: '<p>nope</p>',
          css: null,
          height: 200,
          textFallback: null,
        }),
      }),
    );

    expect(widget).toBeNull();
  });

  it('ignores unrelated tools', () => {
    const widget = resolveShowWidgetForToolMessage(
      buildResult({
        toolName: 'manage_artifacts',
        mcpToolName: 'manage_artifacts',
        output: JSON.stringify({
          success: true,
          shown: true,
          html: '<p>nope</p>',
        }),
      }),
    );

    expect(widget).toBeNull();
  });
});

describe('buildShowWidgetSrcDoc', () => {
  it('wraps fragments with CSP, default styles, and title', () => {
    const doc = buildShowWidgetSrcDoc({
      title: 'Card',
      html: '<p>Hello</p>',
      css: 'p{font-weight:700}',
      height: 320,
      textFallback: null,
    });

    expect(doc).toContain('<!DOCTYPE html>');
    expect(doc).toContain('<title>Card</title>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('p{font-weight:700}');
    expect(doc).toContain('<p>Hello</p>');
    expect(doc).toContain('color-scheme: light');
    expect(doc).toContain('--rw-surface: #fafaf9');
    expect(doc).toContain('.rw-card');
    expect(doc).toContain('data-theme="light"');
  });

  it('injects the resolved host theme before custom widget CSS', () => {
    const darkTheme: ShowWidgetHostTheme = {
      colorScheme: 'dark',
      background: 'oklch(0.2 0 0)',
      surface: 'oklch(0.1 0 0)',
      surfaceMuted: 'oklch(0.3 0 0)',
      text: 'white',
      textMuted: 'lightgray',
      border: 'gray',
      primary: 'lime',
      primaryForeground: 'black',
      accent: 'chartreuse',
      success: 'teal',
      warning: 'orange',
      danger: 'red',
      codeBackground: '#222',
      radius: '8px',
      fontSans: 'Test Sans, sans-serif',
      fontMono: 'Test Mono, monospace',
    };
    const doc = buildShowWidgetSrcDoc(
      {
        title: 'Themed card',
        html: '<div class="rw-card">Ready</div>',
        css: '.rw-card { outline-color: var(--rw-accent); }',
        height: 240,
        textFallback: null,
      },
      darkTheme,
    );

    expect(doc).toContain('data-theme="dark"');
    expect(doc).toContain('color-scheme: dark');
    expect(doc).toContain('--rw-background: oklch(0.2 0 0)');
    expect(doc).toContain('--rw-primary: lime');
    expect(doc.indexOf('--rw-primary: lime')).toBeLessThan(
      doc.indexOf('outline-color: var(--rw-accent)'),
    );
  });

  it('always wraps fragments under a controlled head so remote shells cannot re-enter', () => {
    const doc = buildShowWidgetSrcDoc({
      title: null,
      html: '<html><head><link rel="stylesheet" href="https://evil.example/x.css"></head><body><b>x</b></body></html>',
      css: null,
      height: 200,
      textFallback: null,
    });

    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('<b>x</b>');
    expect(doc).toMatch(
      /^<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8">[\s\S]*<\/head><body>/,
    );
  });

  it('neutralizes style-tag breakout attempts in custom CSS', () => {
    const doc = buildShowWidgetSrcDoc({
      title: null,
      html: '<p>x</p>',
      css: '</style><script>alert(1)</script><style>p{color:red}',
      height: 200,
      textFallback: null,
    });

    expect(doc).not.toContain('</style><script>');
    expect(doc).not.toContain('<script>');
    expect(doc).toContain('p{color:red}');
  });
});
