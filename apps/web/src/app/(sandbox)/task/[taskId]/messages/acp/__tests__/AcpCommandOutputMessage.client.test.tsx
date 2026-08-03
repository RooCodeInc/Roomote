import { fireEvent, render, screen } from '@testing-library/react';
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders completed command output in a bounded collapsed viewer', () => {
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

    render(<AcpCommandOutputMessage msg={msg} status="completed" showOutput />);

    expect(codeBlockSpy).toHaveBeenCalledTimes(1);
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: true,
        defaultCollapsed: true,
        renderContent: true,
        maxHeight: 240,
        highlight: false,
        showCommandCopy: true,
        showOutputCopy: true,
      }),
    );
    expect(codeBlockSpy.mock.calls[0]?.[0]).not.toHaveProperty('forceDark');
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

    render(
      <AcpCommandOutputMessage msg={msg} status="in_progress" showOutput />,
    );

    expect(codeBlockSpy).toHaveBeenCalledTimes(1);
    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: false,
        defaultCollapsed: false,
        renderContent: false,
        maxHeight: 240,
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

  it('shows elapsed and quiet time while a command is running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_000);
    const msg: AcpToolCallUiMessage = {
      ...baseMsg,
      ts: 11_000,
      startedAt: 1_000,
      kind: 'tool_call',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        status: 'in_progress',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="in_progress" />);

    expect(
      screen.getByText('→ running 30s · last update 20s ago'),
    ).toBeInTheDocument();
  });

  it('opens live command output as soon as content arrives', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: 'Counting objects: 42%\nCompressing objects: 12%',
      kind: 'tool_result',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        exitCode: null,
        output: 'Counting objects: 42%\nCompressing objects: 12%',
        status: 'in_progress',
      },
    };

    render(
      <AcpCommandOutputMessage msg={msg} status="in_progress" showOutput />,
    );

    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'Counting objects: 42%\nCompressing objects: 12%',
        collapsible: true,
        defaultCollapsed: false,
        renderContent: true,
        maxHeight: 240,
        highlight: false,
        showOutputCopy: true,
      }),
    );
  });

  it('keeps command output hidden when the preference is disabled', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      text: 'Counting objects: 42%',
      kind: 'tool_result',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        exitCode: null,
        output: 'Counting objects: 42%',
        status: 'in_progress',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="in_progress" />);

    expect(codeBlockSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsible: false,
        renderContent: false,
        showOutputCopy: false,
      }),
    );
  });

  it('marks a pending command as last-known when the live connection is lost', () => {
    const msg: AcpToolCallUiMessage = {
      ...baseMsg,
      kind: 'tool_call',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        status: 'in_progress',
      },
    };

    render(
      <AcpCommandOutputMessage
        msg={msg}
        status="in_progress"
        connected={false}
        connectionWasEstablished
      />,
    );

    expect(
      screen.getByText('→ last known running · connection lost'),
    ).toBeInTheDocument();
    expect(codeBlockCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({ spinner: false }),
    );
  });

  it('shows the final command duration', () => {
    const msg: AcpToolResultUiMessage = {
      ...baseMsg,
      ts: 6_000,
      startedAt: 1_000,
      kind: 'tool_result',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        exitCode: 0,
        output: '',
        status: 'completed',
      },
    };

    render(<AcpCommandOutputMessage msg={msg} status="completed" />);

    expect(screen.getByText('→ completed in 5s')).toBeInTheDocument();
  });

  it('offers an abort action for the active command', () => {
    const onAbort = vi.fn();
    const msg: AcpToolCallUiMessage = {
      ...baseMsg,
      kind: 'tool_call',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        status: 'in_progress',
      },
    };

    render(
      <AcpCommandOutputMessage
        msg={msg}
        status="in_progress"
        canAbort
        onAbort={onAbort}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('keeps the abort action disabled while the turn is stopping', () => {
    const msg: AcpToolCallUiMessage = {
      ...baseMsg,
      kind: 'tool_call',
      data: {
        toolCallId: 'tool-call-1',
        kind: 'execute',
        title: null,
        isExecute: true,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: 'git push',
        status: 'in_progress',
      },
    };

    render(
      <AcpCommandOutputMessage
        msg={msg}
        status="in_progress"
        canAbort
        abortPending
        onAbort={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled();
  });
});
