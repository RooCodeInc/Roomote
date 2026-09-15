import { fireEvent, render, screen } from '@testing-library/react';

import { AcpActivityGroupMessage } from '../AcpActivityGroupMessage';
import { AcpTranscriptBlockList } from '../AcpTranscriptBlocks';
import type { AcpActivityGroupRenderBlock } from '../activity-groups';
import type { AcpToolCallUiMessage, AcpUiMessage } from '../types';

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
