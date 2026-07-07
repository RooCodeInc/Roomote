import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from '../types';

const codeBlockSpy = vi.fn();
const codeBlockCommandSpy = vi.fn();

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: ({ children, ...props }: { children?: ReactNode }) => {
    codeBlockSpy(props);
    return <div>{children}</div>;
  },
  CodeBlockCommand: ({
    children,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
  }) => {
    codeBlockCommandSpy(props);
    return <span>{children}</span>;
  },
  CodeBlockHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  CodeBlockTitle: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  Message: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { AcpCommandOutputMessage } from '../AcpCommandOutputMessage';

const baseMsg = {
  id: 'test-id',
  ts: 1,
  role: 'assistant' as const,
  partial: false,
  sessionId: null,
  updateType: 'roomote_runtime.tool_result' as const,
};

describe('AcpCommandOutputMessage', () => {
  beforeEach(() => {
    codeBlockSpy.mockClear();
    codeBlockCommandSpy.mockClear();
  });

  it('renders command headers without expandable raw output', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: '$ pnpm test\nPASS src/example.test.ts',
      kind: 'tool_result',
      data: {
        toolCallId: null,
        kind: 'execute_command',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'pnpm test',
        exitCode: 0,
        output: '',
        status: 'completed',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="completed" />);

    expect(codeBlockSpy).toHaveBeenCalledTimes(1);
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: false,
        defaultCollapsed: false,
        renderContent: false,
        maxHeight: undefined,
        showCommandCopy: true,
        showOutputCopy: false,
      }),
    );
  });

  it('keeps command output blocks non-collapsible even when there is no output to show', () => {
    const msg: AcpToolCallUiMessage = {
      ...baseMsg,
      text: '   \n',
      kind: 'tool_call',
      data: {
        toolCallId: null,
        kind: 'execute_command',
        title: null,
        isExecute: true,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'pnpm test',
        status: 'in_progress',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="in_progress" />);

    expect(codeBlockSpy).toHaveBeenCalledTimes(1);
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: false,
        defaultCollapsed: false,
        renderContent: false,
        maxHeight: undefined,
        showOutputCopy: false,
      }),
    );
  });

  it('does not render status text when exit code is 0', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: 'success',
      kind: 'tool_result',
      data: {
        toolCallId: null,
        kind: 'execute_command',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'pnpm test',
        exitCode: 0,
        output: '',
        status: 'completed',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="completed" />);

    expect(screen.queryByText('→ exit 0')).not.toBeInTheDocument();
  });

  it('renders status text when exit code is non-zero', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: 'failed',
      kind: 'tool_result',
      data: {
        toolCallId: null,
        kind: 'execute_command',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'pnpm test',
        exitCode: 1,
        output: '',
        status: 'completed',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="completed" />);

    expect(screen.getByText('→ exit 1')).toBeInTheDocument();
  });

  it('keeps the command header inline with status text instead of growing to fill the row', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: 'failed',
      kind: 'tool_result',
      data: {
        toolCallId: null,
        kind: 'execute_command',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'pnpm test',
        exitCode: 1,
        output: '',
        status: 'completed',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="completed" />);

    expect(codeBlockCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        className: expect.stringContaining('grow-0'),
      }),
    );
    expect(codeBlockCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        className: expect.stringContaining('basis-auto'),
      }),
    );
  });
});
