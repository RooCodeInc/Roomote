import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpToolDetails } from '../AcpToolDetails';
import type { AcpToolResultUiMessage } from '../types';

const codeBlockSpy = vi.fn();
const toolInputSpy = vi.fn();

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: (props: {
    code: string;
    variant?: string;
    highlight?: boolean;
    className?: string;
  }) => {
    codeBlockSpy(props);
    return <div>{props.code}</div>;
  },
  ToolInput: (props: { input: unknown; children?: ReactNode }) => {
    toolInputSpy(props);
    return <div>tool input</div>;
  },
}));

function buildMessage(
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
    text: 'Spawning subagent',
    data: {
      toolCallId: 'call-1',
      kind: 'subagent',
      title: 'Spawned subagent',
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

describe('AcpToolDetails', () => {
  beforeEach(() => {
    codeBlockSpy.mockClear();
    toolInputSpy.mockClear();
  });

  it('shows the subagent launch prompt and most recent message without debug mode', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: 'Review the current branch and summarize the state.',
          output: 'The branch is clean and the relevant tests pass.',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(
      screen.getByText('Review the current branch and summarize the state.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Initial prompt')).toBeInTheDocument();
    expect(screen.getByText('Last message')).toBeInTheDocument();
    expect(
      screen.getByText('The branch is clean and the relevant tests pass.'),
    ).toBeInTheDocument();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('shows the most recent subagent message when no prompt is available', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: null,
          output: 'Found the requested implementation detail.',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(screen.getByText('Last message')).toBeInTheDocument();
    expect(
      screen.getByText('Found the requested implementation detail.'),
    ).toBeInTheDocument();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('shows the launch prompt from rawInput for OpenCode task rows', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: null,
          isSubagentSpawn: true,
          rawInput: {
            prompt: 'Inspect the OpenCode task tool prompt payload.',
            subagent_type: 'explore',
          },
        } as Partial<AcpToolResultUiMessage['data']>)}
      />,
    );

    expect(
      screen.getByText('Inspect the OpenCode task tool prompt payload.'),
    ).toBeInTheDocument();
    expect(toolInputSpy).not.toHaveBeenCalled();
  });

  it('shows structured payload details for subagent rows in debug mode', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: 'Review the current branch and summarize the state.',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          output: 'Found the issue and confirmed the failing path.',
          isSubagentSpawn: true,
        })}
        showSubagentPayload={true}
      />,
    );

    expect(toolInputSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          output: 'Found the issue and confirmed the failing path.',
          prompt: 'Review the current branch and summarize the state.',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
        }),
      }),
    );
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('uses a light compact code block for non-subagent tool output text', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          kind: 'search',
          title: 'Search workspace',
          isSubagentSpawn: false,
        })}
      />,
    );

    expect(screen.getByText('Spawning subagent')).toBeInTheDocument();
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'Spawning subagent',
        variant: 'compact',
        highlight: false,
        className: expect.stringContaining('bg-transparent'),
      }),
    );
  });

  it('hides expanded details for Roomote Slack lifecycle tools', () => {
    const { container } = render(
      <AcpToolDetails
        msg={buildMessage({
          kind: 'mcp',
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

    expect(container).toBeEmptyDOMElement();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });
});
