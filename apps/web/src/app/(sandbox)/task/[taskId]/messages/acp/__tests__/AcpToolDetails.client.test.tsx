import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpToolDetails } from '../AcpToolDetails';
import type { AcpToolResultUiMessage } from '../types';

const codeBlockSpy = vi.fn();
const toolInputSpy = vi.fn();

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: (props: { code: string }) => {
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

  it('shows the subagent launch prompt when expanding without debug mode', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: 'Review the current branch and summarize the state.',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(
      screen.getByText('Review the current branch and summarize the state.'),
    ).toBeInTheDocument();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('hides expanded details for subagent rows without a prompt', () => {
    const { container } = render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: null,
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
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

  it('keeps using a code block for non-subagent tool output text', () => {
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
      expect.objectContaining({ code: 'Spawning subagent' }),
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
