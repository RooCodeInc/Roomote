import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AcpGroupedToolMessage } from '../AcpGroupedToolMessage';
import type { GroupedToolCallRenderBlock } from '../render-blocks';

vi.mock('@/components/ai-elements', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  Message: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div id={id}>{children}</div>
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
  // Simulate collapsed mode where ToolContent children are not mounted.
  ToolContent: () => <div data-testid="collapsed-tool-content" />,
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
    objectSummary: '3 files',
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
          text: 'a',
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
            output: 'a',
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
          text: 'b',
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
            output: 'b',
            status: 'completed',
          },
        },
      },
      {
        objectLabel: 'file_c.txt',
        groupKey: 'mcp:roomote:read_file',
        displayKind: 'read',
        stepKind: 'read',
        msg: {
          id: 'tool-3',
          ts: 102,
          role: 'tool',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.tool_result',
          kind: 'tool_result',
          text: 'c',
          data: {
            toolCallId: 'call-3',
            kind: 'read',
            title: 'Read file_c.txt',
            isExecute: false,
            isMcp: true,
            mcpServerName: 'roomote',
            mcpToolName: 'read_file',
            serverName: 'roomote',
            toolName: 'read_file',
            command: null,
            exitCode: null,
            output: 'c',
            status: 'completed',
          },
        },
      },
    ],
  };
}

describe('AcpGroupedToolMessage anchors', () => {
  it('keeps per-item anchors mounted even when tool content is collapsed', () => {
    render(<AcpGroupedToolMessage group={buildGroup()} />);

    const collapsedContent = screen.getByTestId('collapsed-tool-content');

    expect(document.getElementById('msg-101')).toBeTruthy();
    expect(document.getElementById('msg-102')).toBeTruthy();
    expect(collapsedContent.querySelector('#msg-101')).toBeNull();
    expect(collapsedContent.querySelector('#msg-102')).toBeNull();

    // Subheadings live inside ToolContent and should not be mounted in collapsed mode.
    expect(screen.queryByText('file_b.txt')).toBeNull();
    expect(screen.queryByText('file_c.txt')).toBeNull();
  });
});
