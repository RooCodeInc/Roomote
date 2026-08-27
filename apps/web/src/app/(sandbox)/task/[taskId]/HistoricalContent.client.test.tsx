import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { isTaskRunAsleepMock, retryFailedStartMutate } = vi.hoisted(() => ({
  isTaskRunAsleepMock: vi.fn(() => false),
  retryFailedStartMutate: vi.fn(),
}));

vi.mock('@/components/system', () => ({
  ArrowUpRightIcon: () => <svg aria-hidden="true" />,
  ArrowRight: () => <svg aria-hidden="true" />,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Check: () => <svg aria-hidden="true" />,
  HelpCircle: () => <svg aria-hidden="true" />,
  Loader2: () => <svg aria-hidden="true" />,
  Sun: () => <svg aria-hidden="true" />,
  X: () => <svg aria-hidden="true" />,
}));

vi.mock('@/hooks/task-runs', () => ({
  useRetryFailedTaskStart: () => ({
    mutate: retryFailedStartMutate,
    isPending: false,
  }),
}));

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Shimmer: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/layout', () => ({
  WorkspaceSurface: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('./hooks', () => ({
  ArtifactLinkProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  PreviewPaneProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  TaskSidePanelProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useClosePreviewOnSleep: vi.fn(),
}));

vi.mock('./sidebar-actions', () => ({
  SidebarActions: () => null,
}));

vi.mock('./sidebar-actions/utils', () => ({
  isTaskRunAsleep: isTaskRunAsleepMock,
}));

vi.mock('./DraftPromptBanner', () => ({
  DraftPromptBanner: () => <div>Draft prompt banner</div>,
}));

vi.mock('./Header', () => ({
  Header: () => <div>Header</div>,
}));

vi.mock('./Messages', () => ({
  Messages: ({ footer }: { footer?: ReactNode }) => (
    <div>
      <div>Messages</div>
      {footer}
    </div>
  ),
}));

vi.mock('./PreviewCommand', () => ({
  PreviewCommand: () => null,
}));

vi.mock('./PreviewPaneLayout', () => ({
  PreviewPaneLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./WakeTaskInput', () => ({
  WakeTaskInput: () => <div>Wake task input</div>,
}));

import { HistoricalContent } from './HistoricalContent';

describe('HistoricalContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTaskRunAsleepMock.mockReturnValue(false);
  });

  it('shows an in-thread waking up message while the task is resuming', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'resuming',
            draftPrompt: null,
            taskRun: {
              id: 123,
              snapshotId: 'snap-123',
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.getByText('Waking up')).toBeInTheDocument();
  });

  it('does not show the waking up message outside the resuming state', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 123,
              snapshotId: 'snap-123',
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    expect(screen.queryByText('Waking up')).not.toBeInTheDocument();
  });

  it('shows a transcript error footer when a historical task exits with result.error', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 123,
              status: 'failed',
              error: null,
              result: {
                error:
                  'Required environment command Install dependencies failed for owner/repo: Command failed with exit code 1',
              },
              snapshotId: null,
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Task ended because of an error:'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Required environment command Install dependencies failed for owner/repo: Command failed with exit code 1',
      ),
    ).toBeInTheDocument();
  });

  it('offers a retry when the server says the start can be relaunched', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 3734,
              status: 'failed',
              payloadKind: 'standard',
              canRetryFailedStart: true,
              error: 'The operation was aborted due to timeout',
              result: null,
              snapshotId: null,
              createdAt: new Date('2026-08-03T13:14:56.000Z'),
              startedAt: null,
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryFailedStartMutate).toHaveBeenCalledWith({
      taskId: 'task-123',
      runId: 3734,
    });
  });

  it('offers no retry once the late transcript has landed', () => {
    // The sandbox came up after the provisioning deadline: the run is
    // failed but the agent's work is in the thread, so the server refuses
    // the relaunch (it would redo work that already happened) and reports
    // canRetryFailedStart: false.
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 3734,
              status: 'failed',
              payloadKind: 'standard',
              canRetryFailedStart: false,
              error: 'The operation was aborted due to timeout',
              result: null,
              snapshotId: null,
              createdAt: new Date('2026-08-03T13:14:56.000Z'),
              startedAt: null,
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Task ended because of an error:'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
  });

  it('offers no retry when the run carries no server verdict', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 3734,
              status: 'failed',
              payloadKind: 'snapshot_resume',
              error: 'The operation was aborted due to timeout',
              result: null,
              snapshotId: null,
              createdAt: new Date('2026-08-03T13:14:56.000Z'),
              startedAt: null,
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
      />,
    );

    expect(
      screen.getByText('Task ended because of an error:'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
  });

  it('prefers an explicit footer over the generic task error footer', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 123,
              status: 'failed',
              error: null,
              result: {
                error:
                  'Required environment command Install dependencies failed for owner/repo: Command failed with exit code 1',
              },
              snapshotId: null,
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
          } as never
        }
        footer={<div>Custom footer</div>}
      />,
    );

    expect(screen.getByText('Custom footer')).toBeInTheDocument();
    expect(
      screen.queryByText('Task ended because of an error:'),
    ).not.toBeInTheDocument();
  });

  it('guides users from a completed onboarding task to their first task', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 123,
              status: 'completed',
              snapshotId: null,
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
            onboardingEnvironment: {
              name: 'Satanama',
              isVerified: true,
              verificationTaskId: 'verify-123',
              verificationTaskActive: false,
              verifiedAt: new Date('2026-05-22T21:00:00.000Z'),
              verificationError: null,
            },
          } as never
        }
      />,
    );

    expect(
      screen.getByText('The Satanama environment is set up and verified.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('You can start your first task now.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('shows an unverified onboarding environment as set up but not verified', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            taskRun: {
              id: 123,
              status: 'completed',
              snapshotId: null,
              createdAt: new Date('2026-05-22T20:57:00.000Z'),
              startedAt: new Date('2026-05-22T20:58:30.000Z'),
            },
            taskId: 'task-123',
            artifacts: [],
            onboardingEnvironment: {
              name: 'Satanama',
              isVerified: false,
              verificationTaskId: null,
              verificationTaskActive: false,
              verifiedAt: null,
              verificationError: null,
            },
          } as never
        }
      />,
    );

    expect(
      screen.getByText(
        'The Satanama environment is set up, but not verified yet.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You can start a task, but it's worth checking verification before relying on it.",
      ),
    ).toBeInTheDocument();
  });
});
