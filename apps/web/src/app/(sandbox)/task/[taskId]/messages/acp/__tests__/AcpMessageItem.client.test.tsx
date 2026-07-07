import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpMessageItem } from '../AcpMessageItem';
import type { AcpToolResultUiMessage } from '../types';

const commandOutputSpy = vi.fn();
const toolMessageSpy = vi.fn();

vi.mock('../AcpCommandOutputMessage', () => ({
  AcpCommandOutputMessage: (props: unknown) => {
    commandOutputSpy(props);
    return <div>command output</div>;
  },
}));

vi.mock('../AcpToolMessage', () => ({
  AcpToolMessage: ({ children, ...props }: { children?: ReactNode }) => {
    toolMessageSpy(props);
    return <div>tool message{children}</div>;
  },
}));

vi.mock('../AcpTextMessage', () => ({
  AcpTextMessage: () => <div>text message</div>,
}));

vi.mock('../AcpReasoningMessage', () => ({
  AcpReasoningMessage: () => <div>reasoning message</div>,
}));

vi.mock('../AcpTodoSectionMessage', () => ({
  AcpTodoSectionMessage: () => <div>todo section</div>,
}));

vi.mock('../AcpUnknownMessage', () => ({
  AcpUnknownMessage: () => <div>unknown message</div>,
}));

function buildToolResult(
  kind: string,
  overrides?: Partial<AcpToolResultUiMessage['data']>,
): AcpToolResultUiMessage {
  return {
    id: `tool-${kind}`,
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: 'tool output',
    data: {
      toolCallId: `call-${kind}`,
      kind,
      title: kind,
      status: 'completed',
      isExecute: kind === 'execute',
      isMcp: kind === 'mcp',
      mcpServerName: kind === 'mcp' ? 'roomote' : null,
      mcpToolName: kind === 'mcp' ? 'get_task' : null,
      command: kind === 'execute' ? 'pnpm test' : null,
      exitCode: kind === 'execute' ? 0 : null,
      output: 'tool output',
      ...overrides,
    },
  };
}

describe('AcpMessageItem tool routing', () => {
  beforeEach(() => {
    commandOutputSpy.mockClear();
    toolMessageSpy.mockClear();
  });

  it('renders OpenCode execute tools as command output', () => {
    const msg = buildToolResult('execute');

    render(<AcpMessageItem msg={msg} />);

    expect(screen.getByText('command output')).toBeInTheDocument();
    expect(commandOutputSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        msg,
        status: 'completed',
      }),
    );
    expect(toolMessageSpy).not.toHaveBeenCalled();
  });

  it.each(['read', 'search', 'mcp', 'subagent'])(
    'renders %s tools as standard tool rows',
    (kind) => {
      const msg = buildToolResult(kind);

      render(<AcpMessageItem msg={msg} />);

      expect(screen.getByText('tool message')).toBeInTheDocument();
      expect(toolMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg,
          showSubagentPayload: false,
        }),
      );
      expect(commandOutputSpy).not.toHaveBeenCalled();
    },
  );
});
