import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpGroupedToolMessage } from '../AcpGroupedToolMessage';
import type { GroupedToolCallRenderBlock } from '../render-blocks';

const codeBlockSpy = vi.fn();

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: (props: { code: string }) => {
    codeBlockSpy(props);
    return <pre>{props.code}</pre>;
  },
  Message: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  Tool: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ToolHeader: ({
    action,
    object,
  }: {
    action: string;
    object?: string;
    icon?: unknown;
    state?: string;
    collapsible?: boolean;
  }) => (
    <div>
      {action}
      {object ? ` ${object}` : ''}
    </div>
  ),
  ToolContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ToolInput: ({ input }: { input: unknown }) => (
    <pre>{JSON.stringify(input)}</pre>
  ),
}));

function buildGroup(): GroupedToolCallRenderBlock {
  return {
    kind: 'tool_group',
    id: 'tool-1',
    ts: 100,
    action: 'Exploring',
    objectSummary: '2 files',
    items: [
      {
        objectLabel: 'file_a.txt',
        stepKind: 'read',
        msg: {
          id: 'tool-1',
          ts: 100,
          role: 'tool',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.tool_result',
          kind: 'tool_result',
          text: 'alpha contents',
          data: {
            toolCallId: 'call-1',
            kind: 'read',
            title: 'Read file_a.txt',
            isExecute: false,
            isMcp: true,
            mcpServerName: 'roomote',
            mcpToolName: 'read_file',
            serverName: 'roomote',
            toolName: 'read_file',
            command: null,
            exitCode: null,
            output: 'alpha contents',
            status: 'completed',
          },
        },
      },
      {
        objectLabel: 'file_b.txt',
        stepKind: 'read',
        msg: {
          id: 'tool-2',
          ts: 101,
          role: 'tool',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.tool_result',
          kind: 'tool_result',
          text: 'beta contents',
          data: {
            toolCallId: 'call-2',
            kind: 'read',
            title: 'Read file_b.txt',
            isExecute: false,
            isMcp: true,
            mcpServerName: 'roomote',
            mcpToolName: 'read_file',
            serverName: 'roomote',
            toolName: 'read_file',
            command: null,
            exitCode: null,
            output: 'beta contents',
            status: 'completed',
          },
        },
      },
    ],
  };
}

describe('AcpGroupedToolMessage', () => {
  beforeEach(() => {
    codeBlockSpy.mockClear();
  });

  it('renders grouped header and per-file sections', () => {
    render(<AcpGroupedToolMessage group={buildGroup()} />);

    expect(screen.getByText('Exploring 2 files')).toBeInTheDocument();
    expect(screen.getByText('file_a.txt')).toBeInTheDocument();
    expect(screen.getByText('file_b.txt')).toBeInTheDocument();
    expect(screen.getByText('file_a.txt').className).toContain('truncate');
    expect(screen.getByText('file_b.txt').className).toContain('truncate');

    expect(codeBlockSpy).not.toHaveBeenCalled();
  });
});
