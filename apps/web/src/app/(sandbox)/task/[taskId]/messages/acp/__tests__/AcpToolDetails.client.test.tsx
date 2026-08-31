import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpToolDetails } from '../AcpToolDetails';
import type { AcpToolResultUiMessage } from '../types';

const codeBlockSpy = vi.fn();
const toolInputSpy = vi.fn();

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: (props: {
    code: string;
    language: string;
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
  MessageResponse: (props: { children?: ReactNode }) => (
    <div>{props.children}</div>
  ),
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

  it('leads with the most recent message and collapses the launch prompt', () => {
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
      screen.getByText('The branch is clean and the relevant tests pass.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Review the current branch and summarize the state.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Prompt'));

    expect(
      screen.getByText('Review the current branch and summarize the state.'),
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

    expect(
      screen.getByText('Found the requested implementation detail.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Prompt')).not.toBeInTheDocument();
    expect(toolInputSpy).not.toHaveBeenCalled();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('shows the latest live child message while a subagent is running', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: 'Inspect the task transcript implementation.',
          output: '',
          status: 'in_progress',
          subagentActivity: {
            lastMessage: 'The child agent is reviewing the render path.',
          },
          isSubagentSpawn: true,
        } as Partial<AcpToolResultUiMessage['data']>)}
      />,
    );

    expect(
      screen.getByText('The child agent is reviewing the render path.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
  });

  it('leaves the launch prompt open when the subagent has no message yet', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          prompt: 'Inspect the task transcript implementation.',
          output: '',
          status: 'in_progress',
          isSubagentSpawn: true,
        })}
      />,
    );

    expect(
      screen.getByText('Inspect the task transcript implementation.'),
    ).toBeInTheDocument();
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
        language: 'bash',
        variant: 'compact',
        highlight: false,
        className: expect.stringContaining('bg-transparent'),
      }),
    );
  });

  it('renders structured tool details as YAML instead of raw JSON', () => {
    render(
      <AcpToolDetails
        msg={{
          ...buildMessage({
            kind: 'tool',
            title: 'inspect_task',
            isSubagentSpawn: false,
          }),
          text: JSON.stringify({
            taskId: 'task-1',
            details: { status: 'running', attempts: 2 },
            steps: ['inspect', 'report'],
          }),
        }}
      />,
    );

    const code = [
      'taskId: task-1',
      'details:',
      '  status: running',
      '  attempts: 2',
      'steps:',
      '  - inspect',
      '  - report',
    ].join('\n');
    const renderedCode = codeBlockSpy.mock.calls[0]?.[0].code;
    expect(renderedCode).toBe(code);
    expect(renderedCode).not.toContain('{"');
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'yaml' }),
    );
    expect(toolInputSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a JSON string', '"already formatted"'],
    ['a JSON primitive', '42'],
    ['invalid JSON', '{not valid json}'],
    ['already-formatted YAML', 'taskId: task-1\nstatus: running'],
  ])('preserves %s tool detail payload', (_label, text) => {
    render(
      <AcpToolDetails
        msg={{
          ...buildMessage({
            kind: 'tool',
            title: 'inspect_task',
            isSubagentSpawn: false,
          }),
          text,
        }}
      />,
    );

    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: text, language: 'bash' }),
    );
  });

  it.each(['search', 'query'])(
    'renders the sanitized Memory %s input before the result YAML',
    (toolName) => {
      const result = {
        matches: [{ title: 'Existing result', score: 0.98 }],
      };
      render(
        <AcpToolDetails
          msg={{
            ...buildMessage({
              kind: 'mcp',
              title: toolName,
              isMcp: true,
              mcpServerName: 'gbrain',
              mcpToolName: toolName,
              serverName: 'gbrain',
              toolName,
              rawInput: {
                query:
                  'Find /sandbox/repos/RooCodeInc/Roomote notes with api_key=synthetic-test-value',
              },
              output: JSON.stringify(result),
            } as Partial<AcpToolResultUiMessage['data']>),
            text: JSON.stringify(result),
          }}
        />,
      );

      expect(screen.getByText('Input')).toBeInTheDocument();
      expect(screen.getByText('Result')).toBeInTheDocument();
      expect(codeBlockSpy.mock.calls.map(([props]) => props.code)).toEqual([
        'query: Find RooCodeInc/Roomote notes with api_key=[redacted]',
        ['matches:', '  - title: Existing result', '    score: 0.98'].join(
          '\n',
        ),
      ]);
      expect(toolInputSpy).not.toHaveBeenCalled();
    },
  );

  it('adds a sanitized send_task_message message to the existing result YAML', () => {
    const result = { delivered: true, taskId: 'task-1' };
    render(
      <AcpToolDetails
        msg={{
          ...buildMessage({
            kind: 'tool',
            title: 'send_task_message',
            toolName: 'send_task_message',
            rawInput: {
              arguments: {
                taskId: 'task-1',
                message:
                  'Review /sandbox/repos/RooCodeInc/Roomote and use password=synthetic-test-value',
              },
            },
            output: JSON.stringify(result),
          } as Partial<AcpToolResultUiMessage['data']>),
          text: JSON.stringify(result),
        }}
      />,
    );

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(codeBlockSpy.mock.calls.map(([props]) => props.code)).toEqual([
      'message: Review RooCodeInc/Roomote and use password=[redacted]',
      ['delivered: true', 'taskId: task-1'].join('\n'),
    ]);
    expect(codeBlockSpy.mock.calls[0]?.[0].className).toContain(
      '[&_pre]:whitespace-pre-wrap',
    );
    expect(codeBlockSpy.mock.calls[0]?.[0].className).toContain(
      '[&_pre]:min-w-0',
    );
    expect(toolInputSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to unrelated input for recognized tools', () => {
    render(
      <AcpToolDetails
        msg={buildMessage({
          kind: 'mcp',
          title: 'query',
          isMcp: true,
          mcpServerName: 'gbrain',
          mcpToolName: 'query',
          serverName: 'gbrain',
          toolName: 'query',
          rawInput: {
            image: 'password=synthetic-test-value',
          },
        } as Partial<AcpToolResultUiMessage['data']>)}
      />,
    );

    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'Spawning subagent' }),
    );
    expect(toolInputSpy).not.toHaveBeenCalled();
  });

  it('keeps colliding input and result fields separate', () => {
    render(
      <AcpToolDetails
        msg={{
          ...buildMessage({
            kind: 'mcp',
            title: 'query',
            isMcp: true,
            mcpServerName: 'gbrain',
            mcpToolName: 'query',
            serverName: 'gbrain',
            toolName: 'query',
            rawInput: { arguments: { query: 'requested value' } },
            output: JSON.stringify({ query: 'result value', matches: 2 }),
          } as Partial<AcpToolResultUiMessage['data']>),
          text: JSON.stringify({ query: 'result value', matches: 2 }),
        }}
      />,
    );

    expect(codeBlockSpy.mock.calls.map(([props]) => props.code)).toEqual([
      'query: requested value',
      ['query: result value', 'matches: 2'].join('\n'),
    ]);
  });

  it('keeps input visible when a truncated result is no longer valid JSON', () => {
    render(
      <AcpToolDetails
        msg={{
          ...buildMessage({
            kind: 'mcp',
            title: 'query',
            isMcp: true,
            mcpServerName: 'gbrain',
            mcpToolName: 'query',
            serverName: 'gbrain',
            toolName: 'query',
            rawInput: { arguments: { query: 'large result' } },
            output: '{"matches":[\n... output truncated ...\n]}',
          } as Partial<AcpToolResultUiMessage['data']>),
          text: '{"matches":[\n... output truncated ...\n]}',
        }}
      />,
    );

    expect(codeBlockSpy.mock.calls[0]?.[0].code).toBe('query: large result');
    expect(codeBlockSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        language: 'yaml',
        code: expect.stringContaining('output truncated'),
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
