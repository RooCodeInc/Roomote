import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AlertCircle, FileIcon } from '@/components/system';

import { AcpGroupedToolMessage } from '../AcpGroupedToolMessage';
import type { GroupedToolCallRenderBlock } from '../render-blocks';

const codeBlockSpy = vi.fn();
const toolHeaderSpy = vi.fn();

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
  ToolHeader: (props: {
    action: string;
    object?: string;
    icon?: unknown;
    state?: string;
    collapsible?: boolean;
  }) => {
    toolHeaderSpy(props);
    return (
      <div>
        {props.action}
        {props.object ? ` ${props.object}` : ''}
      </div>
    );
  },
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
    groupKey: 'mcp:roomote:read_file',
    displayKind: 'read',
    items: [
      {
        objectLabel: 'file_a.txt',
        groupKey: 'mcp:roomote:read_file',
        displayKind: 'read',
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
        groupKey: 'mcp:roomote:read_file',
        displayKind: 'read',
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
    toolHeaderSpy.mockClear();
  });

  it('keeps grouped read rows compact when no item has expandable details', () => {
    render(<AcpGroupedToolMessage group={buildGroup()} />);

    expect(screen.getByText('Exploring 2 files')).toBeInTheDocument();
    expect(screen.queryByText('file_a.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('file_b.txt')).not.toBeInTheDocument();
    expect(codeBlockSpy).not.toHaveBeenCalled();
  });

  it('keeps the resolved group icon while the header renders running progress', () => {
    const group = buildGroup();
    group.items[0]!.msg.data.status = 'in_progress';

    render(<AcpGroupedToolMessage group={group} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: FileIcon,
        state: 'input-available',
      }),
    );
  });

  it('keeps group failure presentation ahead of running progress', () => {
    const group = buildGroup();
    group.items[0]!.msg.data.status = 'in_progress';
    group.items[1]!.msg.data.status = 'failed';

    render(<AcpGroupedToolMessage group={group} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: AlertCircle,
        state: 'output-error',
      }),
    );
  });
});
