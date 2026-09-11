import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { AlertCircle, Telescope } from '@/components/system';
import { TaskRobotIconProvider } from '@/components/tasks/TaskRobotIcon';
import { resolveTaskRobotIconId } from '@/lib/task-robot-icons';

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
    iconElement?: ReactNode;
    iconAction?: { label: string; onClick: () => void };
  }) => {
    toolHeaderSpy(props);
    return (
      <div>
        {props.iconElement}
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

  it('renders natural timer wording in the group and expanded item headings', () => {
    const group = buildGroup();
    group.action = 'Used';
    group.objectSummary = '2 timer calls';
    group.groupKey = 'mcp:roomote:manage_wakeups';
    group.displayKind = 'generic';
    group.items.forEach((item) => {
      item.objectLabel = 'manage_wakeups';
      item.groupKey = 'mcp:roomote:manage_wakeups';
      item.displayKind = 'generic';
      item.stepKind = null;
      Object.assign(item.msg.data, {
        kind: 'mcp',
        title: 'manage_wakeups',
        toolName: 'manage_wakeups',
        mcpToolName: 'manage_wakeups',
        rawInput: { arguments: { action: 'list' } },
        output: JSON.stringify({ success: true, count: 0, wakeups: [] }),
      });
    });

    render(<AcpGroupedToolMessage group={group} />);

    expect(screen.getByText('Used 2 timer calls')).toBeInTheDocument();
    expect(screen.getAllByText('Listed timers')).toHaveLength(2);
    expect(screen.queryByText('manage_wakeups')).not.toBeInTheDocument();
  });

  it('keeps the resolved group icon while the header renders running progress', () => {
    const group = buildGroup();
    group.items[0]!.msg.data.status = 'in_progress';

    render(<AcpGroupedToolMessage group={group} />);

    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: Telescope,
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

  it.each([true, false])(
    'uses individual identity and only a uniform group header (uniform=%s)',
    (uniform) => {
      const group = buildGroup();
      group.action = 'Completed';
      const taskIds = ['child-a', uniform ? 'child-a' : 'child-b'];
      group.items.forEach((item, index) => {
        Object.assign(item.msg.data, {
          kind: 'mcp',
          toolName: 'manage_tasks',
          mcpToolName: 'manage_tasks',
          rawInput: { action: 'get_messages', taskId: taskIds[index] },
        });
      });
      const onOpenTask = vi.fn();
      const { container } = render(
        <TaskRobotIconProvider
          sessionId="session-1"
          orderedTaskIds={['child-a', 'child-b']}
          onOpenTask={onOpenTask}
        >
          <AcpGroupedToolMessage group={group} />
        </TaskRobotIconProvider>,
      );
      const iconA = resolveTaskRobotIconId({
        sessionId: 'session-1',
        orderedTaskIds: ['child-a', 'child-b'],
        taskId: 'child-a',
      });
      const iconB = resolveTaskRobotIconId({
        sessionId: 'session-1',
        orderedTaskIds: ['child-a', 'child-b'],
        taskId: 'child-b',
      });
      expect(
        container.querySelectorAll(`[data-task-robot-icon="${iconA}"]`),
      ).toHaveLength(uniform ? 3 : 1);
      expect(
        container.querySelectorAll(`[data-task-robot-icon="${iconB}"]`),
      ).toHaveLength(uniform ? 0 : 1);
      expect(toolHeaderSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          iconElement: uniform ? expect.anything() : undefined,
          iconAction: uniform
            ? expect.objectContaining({ label: 'Focus task prompt' })
            : undefined,
        }),
      );
      for (const button of screen.getAllByRole('button', {
        name: 'Focus task prompt',
      }))
        fireEvent.click(button);
      expect(onOpenTask.mock.calls).toEqual(taskIds.map((taskId) => [taskId]));
    },
  );

  it('does not use an unknown item as a group identity and keeps it nonclickable', () => {
    const group = buildGroup();
    group.items.forEach((item) =>
      Object.assign(item.msg.data, {
        kind: 'mcp',
        toolName: 'manage_tasks',
        mcpToolName: 'manage_tasks',
        rawInput: { arguments: { action: 'launch' } },
      }),
    );
    const { container } = render(<AcpGroupedToolMessage group={group} />);
    expect(container.querySelectorAll('[data-task-robot-icon]')).toHaveLength(
      2,
    );
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        iconElement: undefined,
        iconAction: undefined,
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'Focus task prompt' }),
    ).not.toBeInTheDocument();
  });

  it('preserves unrelated item icons when a group contains a failure', () => {
    const group = buildGroup();
    group.items[0]!.msg.data.status = 'failed';
    const { container } = render(<AcpGroupedToolMessage group={group} />);
    expect(
      container.querySelector('.lucide-circle-alert'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-task-robot-icon]'),
    ).not.toBeInTheDocument();
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ icon: AlertCircle, state: 'output-error' }),
    );
  });

  it('preserves failure and running state on individual task items', () => {
    const group = buildGroup();
    group.items.forEach((item, index) =>
      Object.assign(item.msg.data, {
        kind: 'mcp',
        toolName: 'manage_tasks',
        mcpToolName: 'manage_tasks',
        status: index === 0 ? 'failed' : 'in_progress',
        rawInput: { action: 'get_messages', taskId: 'child-a' },
      }),
    );
    const { container } = render(<AcpGroupedToolMessage group={group} />);
    expect(container.querySelectorAll('[data-task-robot-icon]')).toHaveLength(
      1,
    );
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(container.querySelector('.lucide-circle-alert')).toBeInTheDocument();
    expect(toolHeaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: AlertCircle,
        state: 'output-error',
        iconElement: undefined,
      }),
    );
  });
});
