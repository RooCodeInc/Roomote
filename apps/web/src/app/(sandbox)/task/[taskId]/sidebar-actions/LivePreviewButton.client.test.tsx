import { type MouseEventHandler, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  usePreviewUrlsMock,
  useTaskSidePanelMock,
  usePreviewPaneMock,
  openPreviewViewMock,
  openPreviewSetupViewMock,
  openPreviewPaneMock,
  resolvePreviewTargetMock,
  restoreSnapshotMutateAsyncMock,
} = vi.hoisted(() => ({
  usePreviewUrlsMock: vi.fn(),
  useTaskSidePanelMock: vi.fn(),
  usePreviewPaneMock: vi.fn(),
  openPreviewViewMock: vi.fn(),
  openPreviewSetupViewMock: vi.fn(),
  openPreviewPaneMock: vi.fn(),
  restoreSnapshotMutateAsyncMock: vi.fn(),
  resolvePreviewTargetMock: vi.fn(
    ({
      initialPaths,
      previewPath,
      previewServiceName,
      previewUrl,
      previewUrls,
      primaryPortName,
    }: {
      initialPaths?: Record<string, string>;
      previewPath: string | null;
      previewServiceName: string | null;
      previewUrl: string | null;
      previewUrls?: Record<string, string>;
      primaryPortName: string | null;
    }) => {
      if (previewServiceName && previewUrls?.[previewServiceName]) {
        const baseUrl = previewUrls[previewServiceName];
        const path = previewPath ?? initialPaths?.[previewServiceName] ?? '';

        return {
          previewServiceName,
          previewUrl: path ? `${baseUrl}${path}` : baseUrl,
        };
      }

      return {
        previewServiceName: primaryPortName,
        previewUrl,
      };
    },
  ),
}));

vi.mock('@/components/system', () => ({
  AppWindow: () => <svg aria-hidden="true" />,
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../hooks/use-preview-urls', () => ({
  resolvePreviewTarget: resolvePreviewTargetMock,
  usePreviewUrls: usePreviewUrlsMock,
}));

vi.mock('../hooks/use-task-side-panel', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('../hooks/use-preview-pane', () => ({
  usePreviewPane: usePreviewPaneMock,
}));

vi.mock('@/hooks/snapshots', () => ({
  useRestoreTaskRunSnapshot: () => ({
    mutateAsync: restoreSnapshotMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    managedAccess: {
      state: 'active',
      reason: null,
      revision: 1,
      effectiveAt: '2026-01-01T00:00:00.000Z',
      restrictionStartsAt: null,
      remediationUrl: null,
    },
  }),
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({
    href,
    icon: Icon,
    label,
    linkProps,
    disabled,
    onClick,
  }: {
    href?: string;
    icon?: () => ReactNode;
    label?: string;
    linkProps?: {
      onClick?: MouseEventHandler<HTMLAnchorElement>;
      rel?: string;
      target?: string;
    };
    disabled?: boolean;
    onClick?: () => void;
  }) => {
    if (href) {
      return (
        <a
          aria-label={label}
          href={href}
          rel={linkProps?.rel}
          target={linkProps?.target}
          onClick={linkProps?.onClick}
        >
          {Icon ? <Icon /> : null}
        </a>
      );
    }

    return (
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {Icon ? <Icon /> : null}
      </button>
    );
  },
}));

import { LivePreviewButton } from './LivePreviewButton';

describe('LivePreviewButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreSnapshotMutateAsyncMock.mockResolvedValue({
      success: true,
      runId: 456,
      taskId: 'task-1',
    });
    usePreviewUrlsMock.mockReturnValue({
      initialPaths: {
        WEB: '/dashboard',
        API: '/health',
      },
      previewUrl: 'https://web.preview.test/dashboard',
      previewUrls: {
        WEB: 'https://web.preview.test',
        API: 'https://api.preview.test',
      },
      primaryPortName: 'WEB',
    });
    useTaskSidePanelMock.mockReturnValue({
      openPreviewView: openPreviewViewMock,
      openPreviewSetupView: openPreviewSetupViewMock,
      previewPath: null,
      previewServiceName: null,
      isViewActive: vi.fn(() => false),
    });
    usePreviewPaneMock.mockReturnValue({
      openPreviewPane: openPreviewPaneMock,
    });
  });

  it('keeps a standalone Live Preview URL on the control while plain clicks open the side panel', () => {
    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={
          {
            id: 123,
            status: 'running',
            payload: { environmentId: 'env-1' },
          } as never
        }
      />,
    );

    const trigger = screen.getByRole('link', { name: 'Live Preview' });

    expect(trigger).toHaveAttribute(
      'href',
      '/api/auth/preview-iframe?preview_url=https%3A%2F%2Fweb.preview.test%2Fdashboard&task_run_id=123',
    );
    expect(trigger).toHaveAttribute('target', '_blank');

    fireEvent.click(trigger);

    expect(openPreviewPaneMock).toHaveBeenCalledWith(
      'https://web.preview.test/dashboard',
      123,
      'WEB',
    );
    expect(openPreviewViewMock).toHaveBeenCalledWith(
      'https://web.preview.test/dashboard',
      123,
      'WEB',
    );
  });

  it('reopens the last selected preview service and path after switching away', () => {
    useTaskSidePanelMock.mockReturnValue({
      openPreviewView: openPreviewViewMock,
      openPreviewSetupView: openPreviewSetupViewMock,
      previewPath: '/docs?tab=api',
      previewServiceName: 'API',
      isViewActive: vi.fn(() => false),
    });

    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={
          {
            id: 123,
            status: 'running',
            payload: { environmentId: 'env-1' },
          } as never
        }
      />,
    );

    const trigger = screen.getByRole('link', { name: 'Live Preview' });

    expect(trigger).toHaveAttribute(
      'href',
      '/api/auth/preview-iframe?preview_url=https%3A%2F%2Fapi.preview.test%2Fdocs%3Ftab%3Dapi&task_run_id=123',
    );

    fireEvent.click(trigger);

    expect(openPreviewPaneMock).toHaveBeenCalledWith(
      'https://api.preview.test/docs?tab=api',
      123,
      'API',
    );
    expect(openPreviewViewMock).toHaveBeenCalledWith(
      'https://api.preview.test/docs?tab=api',
      123,
      'API',
    );
  });

  it('lets modified clicks use the standalone Live Preview link directly', () => {
    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={
          {
            id: 123,
            status: 'running',
            payload: { environmentId: 'env-1' },
          } as never
        }
      />,
    );

    const trigger = screen.getByRole('link', { name: 'Live Preview' });

    fireEvent.click(trigger, { metaKey: true });
    fireEvent.click(trigger, { ctrlKey: true });

    expect(openPreviewPaneMock).not.toHaveBeenCalled();
    expect(openPreviewViewMock).not.toHaveBeenCalled();
  });

  it('renders nothing for repo-only tasks', () => {
    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={{ id: 123, status: 'running', payload: {} } as never}
      />,
    );

    expect(
      screen.queryByRole('link', { name: 'Live Preview' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Live Preview' }),
    ).not.toBeInTheDocument();
  });

  it('opens the setup view when no preview URL is available', () => {
    usePreviewUrlsMock.mockReturnValue({
      initialPaths: {},
      previewUrl: null,
      previewUrls: null,
      primaryPortName: null,
    });

    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={
          {
            id: 123,
            status: 'running',
            payload: { environmentId: 'env-1' },
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(openPreviewSetupViewMock).toHaveBeenCalledTimes(1);
    expect(openPreviewPaneMock).not.toHaveBeenCalled();
    expect(openPreviewViewMock).not.toHaveBeenCalled();
  });

  it('asks to wake the task when live preview is opened from a sleeping task', async () => {
    render(
      <LivePreviewButton
        taskId="task-1"
        taskRun={
          {
            id: 123,
            snapshotId: 'snapshot-1',
            payload: { environmentId: 'env-1' },
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(
      screen.getByRole('heading', { name: 'Wake up Roomote?' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Wake up' }));

    await waitFor(() =>
      expect(restoreSnapshotMutateAsyncMock).toHaveBeenCalledWith({
        sourceSnapshotId: 'snapshot-1',
        sourceRunId: 123,
        resumePrompt: '',
      }),
    );
  });
});
