import { fireEvent, render, screen } from '@testing-library/react';

import { AcpActivityGroupMessage } from '../AcpActivityGroupMessage';
import { AcpTranscriptBlockList } from '../AcpTranscriptBlocks';
import type { AcpActivityGroupRenderBlock } from '../activity-groups';
import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from '../types';

function buildGroup(): AcpActivityGroupRenderBlock {
  return {
    kind: 'activity_group',
    id: 'activity-1',
    ts: 1_000,
    endTs: 18_000,
    blocks: [],
    live: false,
  };
}

describe('AcpActivityGroupMessage', () => {
  it('starts collapsed and expands to reveal activity details', () => {
    render(
      <AcpActivityGroupMessage
        group={buildGroup()}
        anchorIds={['activity-anchor']}
      >
        <div>Hidden activity</div>
      </AcpActivityGroupMessage>,
    );

    expect(
      screen.getByRole('button', { name: /Worked for 17s/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hidden activity')).not.toBeInTheDocument();
    expect(document.getElementById('activity-anchor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));

    expect(screen.getByText('Hidden activity')).toBeVisible();
  });

  it('updates a live trigger to the latest tool without closing expanded history', () => {
    const group = {
      ...buildGroup(),
      live: true,
      latestToolMessage: {
        id: 'tool-1',
        ts: 2_000,
        role: 'tool',
        kind: 'tool_call',
        partial: true,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.tool_call',
        data: {
          toolCallId: 'call-1',
          kind: 'mcp',
          title: 'manage_tasks',
          status: 'in_progress',
          isExecute: false,
          isRead: false,
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'manage_tasks',
          serverName: 'roomote',
          toolName: 'manage_tasks',
          command: null,
          rawInput: { arguments: { action: 'search' } },
        },
      },
    } as AcpActivityGroupRenderBlock;
    const { rerender } = render(
      <AcpActivityGroupMessage
        group={{ ...group, latestToolMessage: undefined }}
      >
        <div>First activity</div>
      </AcpActivityGroupMessage>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Working' }));
    expect(screen.getByText('First activity')).toBeVisible();

    rerender(
      <AcpActivityGroupMessage group={group}>
        <div>First activity</div>
        <div>Latest activity</div>
      </AcpActivityGroupMessage>,
    );

    expect(
      screen.getByRole('button', { name: /Searching sessions/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('First activity')).toBeVisible();
    expect(screen.getByText('Latest activity')).toBeVisible();
  });

  it('expands reasoning details alongside compact tool activity', () => {
    const tool: AcpToolCallUiMessage = {
      id: 'tool-1',
      ts: 2_000,
      role: 'tool',
      kind: 'tool_call',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.tool_call',
      data: {
        toolCallId: 'call-1',
        kind: 'mcp',
        title: 'manage_tasks',
        status: 'completed',
        isExecute: false,
        isRead: false,
        isMcp: true,
        mcpServerName: 'roomote',
        mcpToolName: 'manage_tasks',
        serverName: 'roomote',
        toolName: 'manage_tasks',
        command: null,
      },
    };
    const group = {
      ...buildGroup(),
      blocks: [{ kind: 'message', msg: tool }],
    } satisfies AcpActivityGroupRenderBlock;

    render(
      <AcpActivityGroupMessage group={group}>
        <div>Reasoning details</div>
      </AcpActivityGroupMessage>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));

    expect(screen.getByRole('list')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Reasoning details')).toBeVisible();
  });

  it.each([
    { live: false, state: 'settled' },
    { live: true, state: 'live' },
  ])(
    'lets each child tool independently expand its input and result in a $state group',
    ({ live }) => {
      const firstTool: AcpToolCallUiMessage = {
        id: 'tool-1',
        ts: 2_000,
        role: 'tool',
        kind: 'tool_call',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.tool_call',
        data: {
          toolCallId: 'call-tool-1',
          kind: 'mcp',
          title: 'query',
          status: 'completed',
          isExecute: false,
          isRead: false,
          isMcp: true,
          mcpServerName: 'gbrain',
          mcpToolName: 'query',
          serverName: 'gbrain',
          toolName: 'query',
          command: null,
          rawInput: { arguments: { query: 'first lookup' } },
        } as AcpToolCallUiMessage['data'] & {
          rawInput: { arguments: { query: string } };
        },
      };
      const secondTool: AcpToolResultUiMessage = {
        id: 'tool-2',
        ts: 3_000,
        role: 'tool',
        kind: 'tool_result',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.tool_result',
        data: {
          toolCallId: 'call-tool-2',
          kind: 'mcp',
          title: 'query',
          status: 'completed',
          isExecute: false,
          isRead: false,
          isMcp: true,
          mcpServerName: 'gbrain',
          mcpToolName: 'query',
          serverName: 'gbrain',
          toolName: 'query',
          command: null,
          exitCode: null,
          output: 'second result',
        },
      };
      const group = {
        ...buildGroup(),
        live,
        latestToolMessage: live ? secondTool : undefined,
        blocks: [
          { kind: 'message', msg: firstTool },
          { kind: 'message', msg: secondTool },
        ],
      } satisfies AcpActivityGroupRenderBlock;

      render(
        <AcpTranscriptBlockList
          blocks={[group]}
          showInternalMessages={false}
          onSuppress={() => {}}
        />,
      );

      const groupTrigger = live
        ? screen.getByRole('button', { name: /Searched my memory/ })
        : screen.getByRole('button', { name: /Worked for 17s/ });
      fireEvent.click(groupTrigger);

      const childTriggers = screen.getAllByRole('button', {
        name: /Searched my memory/,
      });
      const firstChildTrigger = live ? childTriggers[1]! : childTriggers[0]!;
      const secondChildTrigger = live ? childTriggers[2]! : childTriggers[1]!;

      fireEvent.click(firstChildTrigger);
      expect(document.body).toHaveTextContent('first lookup');
      expect(document.body).not.toHaveTextContent('second result');
      expect(groupTrigger).toHaveAttribute('data-state', 'open');
      expect(secondChildTrigger).toHaveAttribute('data-state', 'closed');

      fireEvent.click(secondChildTrigger);
      expect(document.body).toHaveTextContent('second result');
      expect(document.body).toHaveTextContent('first lookup');
      expect(groupTrigger).toHaveAttribute('data-state', 'open');
      expect(firstChildTrigger).toHaveAttribute('data-state', 'open');
      expect(document.querySelectorAll('#msg-2000')).toHaveLength(1);
      expect(document.querySelectorAll('#msg-3000')).toHaveLength(1);
      expect(document.getElementById('msg-2000')).not.toHaveAttribute(
        'aria-hidden',
      );
    },
  );

  it('keeps compact-by-default child tool details available from a native disclosure button', () => {
    const readTool: AcpToolResultUiMessage = {
      id: 'read-tool',
      ts: 2_000,
      role: 'tool',
      kind: 'tool_result',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.tool_result',
      data: {
        toolCallId: 'read-call',
        kind: 'read',
        title: 'Read /tmp/example.txt',
        status: 'completed',
        isExecute: false,
        isRead: true,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        serverName: null,
        toolName: 'read',
        command: null,
        exitCode: null,
        output: 'contents from the file',
      },
    };
    const group = {
      ...buildGroup(),
      blocks: [{ kind: 'message', msg: readTool }],
    } satisfies AcpActivityGroupRenderBlock;

    render(
      <AcpActivityGroupMessage group={group}>
        <div>Reasoning details</div>
      </AcpActivityGroupMessage>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));
    const readTrigger = screen.getByRole('button', {
      name: /Read file/,
    });

    expect(readTrigger.tagName).toBe('BUTTON');
    expect(readTrigger).toHaveAttribute('aria-expanded', 'false');
    readTrigger.focus();
    expect(readTrigger).toHaveFocus();

    fireEvent.click(readTrigger);
    expect(readTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.body).toHaveTextContent('contents from the file');
    expect(
      screen.getByRole('button', { name: /Worked for 17s/ }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('preserves nested child-session details when compacting parent tools', () => {
    const parentTool = {
      id: 'parent-tool',
      ts: 2_000,
      role: 'tool',
      kind: 'tool_call',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.tool_call',
      data: {
        toolCallId: 'parent-call',
        kind: 'subagent',
        title: 'Launching subagent',
        status: 'completed',
        isExecute: false,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        command: null,
      },
    } satisfies AcpToolCallUiMessage;
    const childMessage = (
      id: string,
      kind: 'reasoning' | 'text',
    ): AcpUiMessage => ({
      id,
      ts: 3_000,
      role: 'assistant',
      kind,
      partial: false,
      sessionId: 'child-session',
      updateType: 'roomote_runtime.assistant_message',
      text: id,
      data: {},
    });
    const group = {
      ...buildGroup(),
      blocks: [
        {
          kind: 'message',
          msg: parentTool,
          childBlocks: [
            {
              kind: 'message',
              msg: childMessage('Child reasoning', 'reasoning'),
            },
            { kind: 'message', msg: childMessage('Child reply', 'text') },
          ],
        },
      ],
    } satisfies AcpActivityGroupRenderBlock;

    render(
      <AcpTranscriptBlockList
        blocks={[group]}
        showInternalMessages={false}
        onSuppress={() => {}}
        renderMessage={(message) => <div>{message.text}</div>}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));

    expect(screen.getByText('Child reasoning')).toBeVisible();
    expect(screen.getByText('Child reply')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});
