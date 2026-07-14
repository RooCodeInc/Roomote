import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { Bot, Eye, Search, SquarePen, Wrench } from '@/components/system';

import { AcpToolMessage } from '../AcpToolMessage';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from '../types';

const toolHeaderSpy = vi.fn();
const toolDetailsSpy = vi.fn();

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

  it('does not render returned child text for completed subagent rows', () => {
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

    expect(
      screen.queryByText('Found the issue and confirmed the failing path.'),
    ).not.toBeInTheDocument();
    expect(toolDetailsSpy).not.toHaveBeenCalled();
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
        icon: Eye,
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
});
