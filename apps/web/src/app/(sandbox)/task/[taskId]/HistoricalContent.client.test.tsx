import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { isCloudJobAsleepMock } = vi.hoisted(() => ({
  isCloudJobAsleepMock: vi.fn(() => false),
}));

vi.mock('@/components/system', () => ({
  Sun: () => <svg aria-hidden="true" />,
}));

vi.mock('@/components/ai-elements', () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Shimmer: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/layout', () => ({
  FramedSurface: ({ children }: { children: ReactNode }) => (
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
  isCloudJobAsleep: isCloudJobAsleepMock,
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
    isCloudJobAsleepMock.mockReturnValue(false);
  });

  it('shows an in-thread waking up message while the task is resuming', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'resuming',
            draftPrompt: null,
            cloudJob: {
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
            cloudJob: {
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
            cloudJob: {
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

  it('prefers an explicit footer over the generic task error footer', () => {
    render(
      <HistoricalContent
        session={
          {
            sessionState: 'historical',
            draftPrompt: null,
            cloudJob: {
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
});
