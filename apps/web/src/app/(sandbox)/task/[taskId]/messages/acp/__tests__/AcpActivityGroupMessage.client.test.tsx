import { fireEvent, render, screen } from '@testing-library/react';

import { AcpActivityGroupMessage } from '../AcpActivityGroupMessage';
import type { AcpActivityGroupRenderBlock } from '../activity-groups';
import type { AcpToolCallUiMessage } from '../types';

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

  it('expands tool activity as a compact list instead of full tool messages', () => {
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
        <div>Full tool message</div>
      </AcpActivityGroupMessage>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));

    expect(screen.getByRole('list')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Full tool message')).not.toBeInTheDocument();
  });
});
