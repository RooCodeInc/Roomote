import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunStatus } from '@roomote/types';

const workspaceBadgeMock = vi.fn();
const pullRequestBadgeMock = vi.fn();
const messageSquareTextMock = vi.fn();
const taskStatusIndicatorMock = vi.fn();
const spinnerMock = vi.fn();

vi.mock('@/components/system', () => ({
  MessageSquareText: ({ className }: { className?: string }) => {
    messageSquareTextMock(className);
    return <svg aria-hidden="true" className={className} />;
  },
  Spinner: ({ className }: { className?: string }) => {
    spinnerMock(className);
    return <svg aria-hidden="true" className={className} />;
  },
  Pin: () => <svg aria-hidden="true" />,
  PinOff: () => <svg aria-hidden="true" />,
  HoverCard: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  HoverCardContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="hover-card-content" className={className}>
      {children}
    </div>
  ),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({
    environmentId,
    fallbackLabel,
  }: {
    environmentId?: string;
    fallbackLabel?: string;
  }) => {
    workspaceBadgeMock({ environmentId, fallbackLabel });
    return <span>{fallbackLabel ?? `workspace:${environmentId}`}</span>;
  },
  PullRequestBadge: ({
    repo,
    prNumber,
  }: {
    repo: string;
    prNumber: number;
  }) => {
    pullRequestBadgeMock({ repo, prNumber });
    return (
      <a href={`https://github.com/${repo}/pull/${prNumber}`}>
        {repo}#{prNumber}
      </a>
    );
  },
  TaskStatusIndicator: ({
    compact,
    status,
    phase,
    className,
  }: {
    compact?: boolean;
    status?: RunStatus;
    phase?: string | null;
    className?: string;
  }) => {
    taskStatusIndicatorMock({ compact, status, phase, className });
    return <span data-testid="task-status-indicator" />;
  },
}));

import { SideNavTaskItem } from './SideNavTaskItem';

describe('SideNavTaskItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task hover metadata and pull request badge', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        task={{
          id: 'task-1',
          title: 'Task title',
          cloudJob: {
            status: RunStatus.Running,
            taskPhase: 'running',
            prRepo: 'owner/repo',
            prNumber: 123,
            payload: {
              environmentId: 'env-1',
            },
          },
        }}
        isActive={false}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(screen.getByRole('link', { name: 'Task title' })).toHaveAttribute(
      'href',
      '/task/task-1',
    );
    expect(screen.getByText('Task title')).toBeInTheDocument();
    expect(screen.getByText('Environment env-1')).toBeInTheDocument();
    expect(workspaceBadgeMock).toHaveBeenCalledWith({
      environmentId: 'env-1',
      fallbackLabel: 'Environment env-1',
    });
    expect(messageSquareTextMock).toHaveBeenCalledWith('size-4');
    expect(screen.getByTestId('hover-card-content')).toHaveClass('rounded-xl');
    expect(taskStatusIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compact: true,
        status: RunStatus.Running,
        phase: 'running',
      }),
    );
    expect(pullRequestBadgeMock).toHaveBeenCalledWith({
      repo: 'owner/repo',
      prNumber: 123,
    });

    const prLink = screen.getByRole('link', { name: 'owner/repo#123' });
    expect(prLink).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/pull/123',
    );
  });

  it('toggles pin state and hides optional badges when data is missing', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        task={{
          id: 'task-2',
          title: 'Task two',
          cloudJob: {
            status: RunStatus.Completed,
            taskPhase: null,
            payload: {
              repo: 'invalid_repo_name',
            },
          },
        }}
        isActive={true}
        isPinned={true}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    const pinButton = screen.getByRole('button', { name: 'Unpin task' });
    expect(pinButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pinButton);

    expect(onTogglePin).toHaveBeenCalledWith(false);
    expect(workspaceBadgeMock).not.toHaveBeenCalled();
    expect(pullRequestBadgeMock).not.toHaveBeenCalled();
  });

  it('shows spinner and hides status indicator while task is booting', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        task={{
          id: 'task-3',
          title: 'Task starting',
          cloudJob: {
            status: RunStatus.Pending,
            taskPhase: null,
            payload: {
              environmentId: 'env-3',
            },
          },
        }}
        isActive={false}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(spinnerMock).toHaveBeenCalledWith('size-4 animate-spin');
    expect(messageSquareTextMock).not.toHaveBeenCalled();
    expect(taskStatusIndicatorMock).not.toHaveBeenCalled();
  });

  it('uses live status for indicator on active task and ignores stale booting state', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        task={{
          id: 'task-4',
          title: 'Task with live status',
          cloudJob: {
            status: RunStatus.Pending,
            taskPhase: null,
            payload: {
              environmentId: 'env-4',
            },
          },
        }}
        liveStatus={{
          phase: 'waiting_for_prompt',
          lastErrorMessage: undefined,
        }}
        isActive={true}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(messageSquareTextMock).toHaveBeenCalledWith('size-4');
    expect(spinnerMock).not.toHaveBeenCalled();
    expect(taskStatusIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'waiting_for_prompt',
        status: undefined,
      }),
    );
  });

  it('shows a spinner instead of the status dot in the expanded sidebar row when a task is actively running', () => {
    const onTogglePin = vi.fn();
    const longTitle =
      'Expanded task title with enough text to require a full hover-card label';

    render(
      <SideNavTaskItem
        expanded
        task={{
          id: 'task-5',
          title: longTitle,
          cloudJob: {
            status: RunStatus.Running,
            taskPhase: 'running',
            payload: {
              environmentId: 'env-5',
            },
          },
        }}
        isActive={false}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(screen.getByRole('link', { name: longTitle })).toHaveAttribute(
      'href',
      '/task/task-5',
    );
    expect(screen.getAllByText(longTitle)).toHaveLength(2);
    expect(messageSquareTextMock).not.toHaveBeenCalled();
    expect(taskStatusIndicatorMock).not.toHaveBeenCalled();
    expect(spinnerMock).toHaveBeenCalledWith('size-4 shrink-0 animate-spin');
    expect(screen.getByRole('link', { name: longTitle }).className).toContain(
      'px-4',
    );
    expect(
      screen.getByRole('link', { name: longTitle }).className,
    ).not.toContain('pr-10');
    expect(screen.getByRole('link', { name: longTitle }).className).toContain(
      'py-2',
    );
    expect(screen.getByRole('link', { name: longTitle }).className).toContain(
      'min-h-10',
    );
    expect(screen.getByRole('link', { name: longTitle }).className).toContain(
      'gap-2',
    );
    expect(screen.getAllByText(longTitle)[0]).toHaveClass('line-clamp-2');
    expect(screen.getAllByText(longTitle)[0]).toHaveClass('wrap-break-word');
  });

  it('keeps the expanded pin button discoverable for keyboard users', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        expanded
        task={{
          id: 'task-6',
          title: 'Keyboard pin target',
          cloudJob: {
            status: RunStatus.Running,
            taskPhase: 'running',
            payload: {
              environmentId: 'env-6',
            },
          },
        }}
        isActive={false}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    const link = screen.getByRole('link', { name: 'Keyboard pin target' });
    const pinButton = screen.getByRole('button', { name: 'Pin task' });

    expect(pinButton.className).toContain('right-2');
    expect(pinButton.className).toContain('opacity-0');
    expect(pinButton.className).toContain('focus-visible:!opacity-100');

    fireEvent.focus(link);

    expect(pinButton.className).toContain('opacity-100');
    expect(pinButton.className).toContain('pointer-events-auto');
  });

  it('shows a spinner in the expanded row while a task is booting', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        expanded
        task={{
          id: 'task-7',
          title: 'Expanded booting task',
          cloudJob: {
            status: RunStatus.Pending,
            taskPhase: null,
            payload: {
              environmentId: 'env-7',
            },
          },
        }}
        isActive={false}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(spinnerMock).toHaveBeenCalledWith('size-4 shrink-0 animate-spin');
    expect(taskStatusIndicatorMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Expanded booting task' }).className,
    ).toContain('gap-2');
  });

  it('shows a spinner in the expanded row when live status says the task is running', () => {
    const onTogglePin = vi.fn();

    render(
      <SideNavTaskItem
        expanded
        task={{
          id: 'task-8',
          title: 'Expanded live running task',
          cloudJob: {
            status: RunStatus.Running,
            taskPhase: 'waiting_for_prompt',
            payload: {
              environmentId: 'env-8',
            },
          },
        }}
        liveStatus={{
          phase: 'running',
          lastErrorMessage: undefined,
        }}
        isActive={true}
        isPinned={false}
        isPinPending={false}
        onTogglePin={onTogglePin}
      />,
    );

    expect(spinnerMock).toHaveBeenCalledWith('size-4 shrink-0 animate-spin');
    expect(taskStatusIndicatorMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Expanded live running task' })
        .className,
    ).toContain('gap-2');
  });
});
