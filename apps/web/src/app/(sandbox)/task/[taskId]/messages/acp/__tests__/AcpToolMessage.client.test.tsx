import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';

import { Bot, FileIcon, Search, SquarePen, Wrench } from '@/components/system';

import { AcpToolMessage } from '../AcpToolMessage';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from '../types';

const toolHeaderSpy = vi.fn();
const toolDetailsSpy = vi.fn();
const openArtifactSpy = vi.fn();
const windowOpenSpy = vi.fn();

const mockArtifactLink = {
  openArtifact: openArtifactSpy,
  getArtifactById: () => undefined,
  artifacts: [] as Array<{
    id: string;
    path: string;
    version: number;
    artifactType: string;
    contentType: string;
    size: number;
    createdAt: Date;
    thumbnailUrl?: string;
  }>,
};

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  Tool: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ToolHeader: (props: {
    action: string;
    object?: string;
    suffix?: string;
    icon?: unknown;
    state?: string;
    params?: unknown;
    collapsible?: boolean;
  }) => {
    toolHeaderSpy(props);
    return <div>{props.action}</div>;
  },
  ToolContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('../AcpToolDetails', () => ({
  AcpToolDetails: () => {
    toolDetailsSpy();
    return <div>tool details</div>;
  },
}));

vi.mock('../../../hooks', () => ({
  useArtifactLink: () => mockArtifactLink,
}));

function buildMessage(
  kind: string | null,
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
    text: 'Edit src/example.ts',
    data: {
      toolCallId: 'call-1',
      kind,
      title: 'Edit src/example.ts',
      status: 'completed',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      ...overrides,
    },
  };
}

function buildResultMessage(
  kind: string | null,
  overrides?: Partial<AcpToolResultUiMessage['data']>,
): AcpToolResultUiMessage {
  return {
    id: 'tool-result-1',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: 'Edit src/example.ts',
    data: {
      toolCallId: 'call-1',
      kind,
      title: 'Edit src/example.ts',
      status: 'completed',
      isExecute: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      exitCode: null,
      output: '',
      ...overrides,
    },
  };
}

describe('AcpToolMessage', () => {
  beforeEach(() => {
    toolHeaderSpy.mockClear();
    toolDetailsSpy.mockClear();
    openArtifactSpy.mockClear();
    windowOpenSpy.mockClear();
    mockArtifactLink.artifacts = [];
    vi.stubGlobal('open', windowOpenSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses SquarePen for edit tool calls', () => {
    render(<AcpToolMessage msg={buildMessage('edit')} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: SquarePen,
      }),
    );
  });

  it('uses Bot for subagent tool calls', () => {
    render(<AcpToolMessage msg={buildMessage('subagent')} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: Bot,
        collapsible: false,
      }),
    );
  });

  it('renders subagent launches as compact expandable rows when a prompt is available', () => {
    render(
      <AcpToolMessage
        msg={buildMessage('subagent', {
          prompt:
            'Inspect the task transcript path and summarize what subagent metadata is available.',
          agentType: 'explorer',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'medium',
          receiverThreadIds: ['thread-child-1'],
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(screen.queryByText('Explorer')).not.toBeInTheDocument();
    expect(screen.queryByText('gpt-5.4-mini')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium effort')).not.toBeInTheDocument();
    expect(screen.queryByText('1 child thread')).not.toBeInTheDocument();
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('keeps subagent rows non-expandable when the launch has no prompt summary', () => {
    render(
      <AcpToolMessage
        msg={buildMessage('subagent', {
          prompt: null,
          agentType: 'worker',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'medium',
          receiverThreadIds: ['thread-child-1'],
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: false,
      }),
    );
    expect(toolDetailsSpy).not.toHaveBeenCalled();
  });

  it('expands OpenCode task rows when the launch prompt lives on rawInput', () => {
    render(
      <AcpToolMessage
        msg={buildMessage('subagent', {
          prompt: null,
          agentType: 'explore',
          isSubagentSpawn: true,
          rawInput: {
            prompt:
              'Inspect the OpenCode task tool payload path for expandable prompts.',
            subagent_type: 'explore',
          },
        } as Partial<AcpToolCallUiMessage['data']>)}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('expands completed subagent rows when a returned message is available', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', {
          title: 'Subagent completed',
          output: 'Found the issue and confirmed the failing path.',
          prompt: null,
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('shows subagent payload details when debug visibility is enabled', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', {
          title: 'Subagent completed',
          output: 'Found the issue and confirmed the failing path.',
          prompt: null,
          isSubagentSpawn: true,
        })}
        showSubagentPayload={true}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('renders nested child-session activity inside the subagent row', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', {
          title: 'Subagent completed',
          output: 'Found the issue and confirmed the failing path.',
          prompt: null,
          isSubagentSpawn: true,
        })}
      >
        <div>Child agent says hello.</div>
      </AcpToolMessage>,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(screen.getByText('Child agent says hello.')).toBeInTheDocument();
  });

  it('uses a bullet separator for completed subagent activity receipts', () => {
    const subagentReceiptData = {
      title: 'explore glob',
      isSubagentSpawn: true,
      subagentActivity: {
        agentType: 'explore',
        elapsedMs: 160000,
        toolCallCount: 43,
      },
    } as Partial<AcpToolResultUiMessage['data']>;

    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', subagentReceiptData)}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'explore',
        object: 'explore glob',
        suffix: '2m 40s · 43 calls',
        suffixPrefix: '·',
      }),
    );
  });

  it('renders Roomote Slack lifecycle tools as compact title-only rows', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'send_chat_reply',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'send_chat_reply',
          serverName: 'roomote',
          toolName: 'send_chat_reply',
          output: '{"success":true,"summary":"Brief Slack update."}',
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Used',
        object: 'Send Chat Reply',
        suffix: 'Roomote',
        collapsible: false,
      }),
    );
    expect(toolDetailsSpy).not.toHaveBeenCalled();
  });

  it('renders the gbrain MCP server as Memory', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'query',
          isMcp: true,
          mcpServerName: 'gbrain',
          mcpToolName: 'query',
          serverName: 'gbrain',
          toolName: 'query',
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Used',
        object: 'Query',
        suffix: 'Memory',
      }),
    );
  });

  it('keeps Wrench as the fallback icon for unknown tool kinds', () => {
    render(<AcpToolMessage msg={buildMessage('custom')} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: Wrench,
      }),
    );
  });

  it('hides expanded details for read tool calls', () => {
    render(<AcpToolMessage msg={buildMessage('read')} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: FileIcon,
        collapsible: false,
      }),
    );
    expect(toolDetailsSpy).not.toHaveBeenCalled();
  });

  it('uses Search for search tool calls', () => {
    render(<AcpToolMessage msg={buildMessage('search')} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: Search,
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('renders always-visible visual-proof media instead of tool details', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'manage_artifacts',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_artifacts',
          serverName: 'roomote',
          toolName: 'manage_artifacts',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl: 'https://example.com/view',
            rawUrl: 'https://example.com/raw.png',
          }),
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Used',
        object: 'Manage Artifacts',
        collapsible: false,
      }),
    );
    expect(toolDetailsSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Visual proof' })).toHaveAttribute(
      'src',
      'https://example.com/raw.png',
    );
  });

  it('renders show_widget HTML in a sandboxed iframe instead of tool details', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'show_widget',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'show_widget',
          serverName: 'roomote',
          toolName: 'show_widget',
          output: JSON.stringify({
            success: true,
            shown: true,
            title: 'Plan card',
            html: '<p>Ready</p>',
            css: null,
            height: 240,
            textFallback: 'Ready',
          }),
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Used',
        object: 'Show Widget',
        collapsible: false,
      }),
    );
    expect(toolDetailsSpy).not.toHaveBeenCalled();

    const frame = screen.getByTitle('Plan card');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc') ?? '').toContain('<p>Ready</p>');
    expect(frame.getAttribute('srcdoc') ?? '').toContain('color-scheme: light');
  });

  it('opens the artifact viewer when session path is known', () => {
    mockArtifactLink.artifacts = [
      {
        id: 'art-1',
        path: 'tmp/proof.png',
        version: 3,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 100,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        thumbnailUrl: '/api/artifacts/art-1/raw?sig=fresh',
      },
    ];

    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'manage_artifacts',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_artifacts',
          serverName: 'roomote',
          toolName: 'manage_artifacts',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl: 'https://example.com/view',
            rawUrl: 'https://example.com/raw.png',
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open visual proof' }));

    expect(openArtifactSpy).toHaveBeenCalledWith('tmp/proof.png', 3);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('renders inline visual-proof media for subagent results that uploaded proofs', () => {
    mockArtifactLink.artifacts = [
      {
        id: 'art-1',
        path: 'tmp/capture-visual-proof/proof.png',
        version: 1,
        artifactType: 'visual-proof',
        contentType: 'image/png',
        size: 100,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        thumbnailUrl: '/api/artifacts/art-1/raw?sig=fresh',
      },
    ];

    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', {
          title: 'Capture app screenshot',
          agentType: 'proof-runner',
          isSubagentSpawn: true,
          prompt: null,
          rawInput: {
            prompt: 'Capture the requested screenshot and upload it.',
            subagent_type: 'proof-runner',
          },
          output: [
            '<task id="ses-1" state="completed">',
            '<task_result>',
            'Summary: uploaded one screenshot.',
            '- viewUrl: https://example.com/task/t1/artifacts/tmp/capture-visual-proof/proof.png?v=1',
            '- rawUrl: https://example.com/api/artifacts/art-1/raw?sig=stale',
            '</task_result>',
            '</task>',
          ].join('\n'),
        } as Partial<AcpToolResultUiMessage['data']>)}
      />,
    );

    expect(screen.getByRole('img', { name: 'Visual proof' })).toHaveAttribute(
      'src',
      '/api/artifacts/art-1/raw?sig=fresh',
    );
    // The subagent row keeps its collapsible prompt/details alongside the
    // always-visible preview.
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open visual proof' }));

    expect(openArtifactSpy).toHaveBeenCalledWith(
      'tmp/capture-visual-proof/proof.png',
      1,
    );
  });

  it('remounts show_widget when the selected Roomote theme changes', async () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'show_widget',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'show_widget',
          serverName: 'roomote',
          toolName: 'show_widget',
          output: JSON.stringify({
            success: true,
            shown: true,
            title: 'Theme preview',
            html: '<div class="rw-card">Ready</div>',
            css: null,
            height: 240,
            textFallback: 'Ready',
          }),
        })}
      />,
    );

    const lightFrame = screen.getByTitle('Theme preview');
    expect(lightFrame.getAttribute('srcdoc') ?? '').toContain(
      'data-theme="light"',
    );

    await act(async () => {
      document.body.classList.add('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const darkFrame = screen.getByTitle('Theme preview');
      expect(darkFrame).not.toBe(lightFrame);
      expect(darkFrame.getAttribute('srcdoc') ?? '').toContain(
        'data-theme="dark"',
      );
    });

    await act(async () => {
      document.body.classList.remove('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('expands subagent results without session artifacts to show their last message', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('subagent', {
          title: 'Capture app screenshot',
          agentType: 'proof-runner',
          isSubagentSpawn: true,
          prompt: null,
          output:
            'viewUrl: https://example.com/task/t1/artifacts/tmp/missing.png?v=1',
        } as Partial<AcpToolResultUiMessage['data']>)}
      />,
    );

    expect(
      screen.queryByRole('img', { name: 'Visual proof' }),
    ).not.toBeInTheDocument();
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
  });

  it('opens the artifact detail from the upload viewUrl when session path is missing', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'manage_artifacts',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_artifacts',
          serverName: 'roomote',
          toolName: 'manage_artifacts',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl:
              'https://example.com/task/task-1/artifacts/tmp/proof.png?v=2',
            rawUrl: 'https://example.com/raw.png',
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open visual proof' }));

    expect(openArtifactSpy).toHaveBeenCalledWith('tmp/proof.png', 2);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('renders a clickable filename for non-image visual-proof uploads', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'manage_artifacts',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_artifacts',
          serverName: 'roomote',
          toolName: 'manage_artifacts',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl:
              'https://example.com/task/task-1/artifacts/tmp/proof.mp4?v=1',
          }),
        })}
      />,
    );

    expect(toolDetailsSpy).not.toHaveBeenCalled();
    expect(screen.getByText('proof.mp4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open visual proof' }));
    expect(openArtifactSpy).toHaveBeenCalledWith('tmp/proof.mp4', 1);
  });

  it('falls back to normal tool details when visual-proof has no path or media', () => {
    render(
      <AcpToolMessage
        msg={buildResultMessage('mcp', {
          title: 'manage_artifacts',
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_artifacts',
          serverName: 'roomote',
          toolName: 'manage_artifacts',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl: 'https://example.com/view-without-path',
          }),
        })}
      />,
    );

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
      }),
    );
    expect(toolDetailsSpy).toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Open visual proof' }),
    ).not.toBeInTheDocument();
  });
});
