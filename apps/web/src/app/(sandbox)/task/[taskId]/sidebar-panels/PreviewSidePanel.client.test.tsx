import { act, fireEvent, render, screen } from '@testing-library/react';
import { within } from '@testing-library/react';
import {
  forwardRef,
  type ForwardedRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

const {
  usePreviewPaneMock,
  usePreviewUrlsMock,
  useTaskSidePanelMock,
  useSandboxClientMock,
  openPreviewPaneMock,
  closePreviewPaneMock,
  updatePreviewPathMock,
  touchKeepaliveMutateMock,
} = vi.hoisted(() => ({
  usePreviewPaneMock: vi.fn(),
  usePreviewUrlsMock: vi.fn(),
  useTaskSidePanelMock: vi.fn(),
  useSandboxClientMock: vi.fn(),
  openPreviewPaneMock: vi.fn(),
  closePreviewPaneMock: vi.fn(),
  updatePreviewPathMock: vi.fn(),
  touchKeepaliveMutateMock: vi.fn().mockResolvedValue(undefined),
}));

let previewPaneUrlState = 'https://web.preview.test/dashboard';
let previewPaneRunIdState = 123;
let previewPaneServiceNameState = 'WEB';
let previewPathState = '/dashboard';

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & Record<string, unknown>) =>
    asChild ? (
      children
    ) : (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  ChevronDown: () => <span aria-hidden="true">v</span>,
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ExternalLink: () => <span aria-hidden="true">ext</span>,
  Input: forwardRef(function MockInput(
    props: InputHTMLAttributes<HTMLInputElement>,
    ref: ForwardedRef<HTMLInputElement>,
  ) {
    return <input ref={ref} {...props} />;
  }),
  LifeBuoyIcon: () => <span aria-hidden="true">help</span>,
  Lock: () => <span aria-hidden="true">lock</span>,
  Loader2: (props: Record<string, unknown>) => <span {...props}>loading</span>,
  X: () => <span aria-hidden="true">x</span>,
  RectangleHorizontal: () => <span aria-hidden="true">mobile</span>,
  ArrowLeft: () => <span aria-hidden="true">left</span>,
  ArrowRight: () => <span aria-hidden="true">right</span>,
  RefreshCw: () => <span aria-hidden="true">refresh</span>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../hooks/SandboxProvider', () => ({
  useSandboxClient: useSandboxClientMock,
}));

vi.mock('../hooks/use-preview-pane', () => ({
  usePreviewPane: usePreviewPaneMock,
}));

vi.mock('../hooks/use-preview-urls', () => ({
  usePreviewUrls: usePreviewUrlsMock,
}));

vi.mock('../hooks/use-task-side-panel', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('./PreviewHelpDialog', () => ({
  PreviewHelpDialog: () => null,
}));

vi.mock('./SidePanelHeader', () => ({
  SidePanelHeader: ({
    title,
    actions,
    titleAdornment,
  }: {
    title?: string;
    actions?: ReactNode;
    titleAdornment?: ReactNode;
  }) => (
    <div data-testid="side-panel-header">
      <span>{title}</span>
      <div>{titleAdornment}</div>
      <div>{actions}</div>
    </div>
  ),
}));

import { PreviewSidePanel } from './PreviewSidePanel';

describe('PreviewSidePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    previewPaneUrlState = 'https://web.preview.test/dashboard';
    previewPaneRunIdState = 123;
    previewPaneServiceNameState = 'WEB';
    previewPathState = '/dashboard';

    usePreviewUrlsMock.mockReturnValue({
      previewUrls: {
        WEB: 'https://web.preview.test',
      },
      initialPaths: {
        WEB: '/dashboard',
      },
      primaryPortName: 'WEB',
    });

    usePreviewPaneMock.mockImplementation(() => ({
      previewPaneUrl: previewPaneUrlState,
      previewPaneRunId: previewPaneRunIdState,
      previewPaneServiceName: previewPaneServiceNameState,
      openPreviewPane: openPreviewPaneMock,
      closePreviewPane: closePreviewPaneMock,
    }));

    useTaskSidePanelMock.mockImplementation(() => ({
      previewServiceName: 'WEB',
      previewPath: previewPathState,
      openPreviewView: vi.fn(),
      updatePreviewPath: updatePreviewPathMock,
    }));

    useSandboxClientMock.mockReturnValue({
      commands: {
        touchKeepalive: {
          mutate: touchKeepaliveMutateMock,
        },
      },
    });
  });

  it('renders browser navigation controls for Live Preview', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Go back' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Go forward' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Reload preview' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Switch to mobile preview' }),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Preview path' })).toHaveValue(
      'dashboard',
    );
    expect(screen.queryByText('Loading preview...')).not.toBeInTheDocument();
  });

  it('renders the external action as an icon-only link and keeps the toolbar and iframe bordered', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Open in external')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Live Preview in a new tab' }),
    ).toHaveAttribute('href', 'https://web.preview.test/dashboard');

    const toolbar = screen
      .getByRole('button', { name: 'Go back' })
      .closest('div');
    expect(toolbar).toHaveClass('border-b-2');
    expect(toolbar).toHaveClass('border-card');
    expect(toolbar).not.toHaveClass('border');
    expect(toolbar).not.toHaveClass('border-background');

    expect(screen.getByTitle('Live Preview')).toHaveClass('border');
    expect(screen.getByTitle('Live Preview')).toHaveClass('border-background');
  });

  it('uses the active service selector as the panel title when multiple services are available', () => {
    usePreviewUrlsMock.mockReturnValue({
      previewUrls: {
        WEB: 'https://web.preview.test',
        API: 'https://api.preview.test',
      },
      initialPaths: {
        WEB: '/dashboard',
        API: '/docs',
      },
      primaryPortName: 'WEB',
    });

    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(
      within(screen.getByTestId('side-panel-header')).queryByText(
        /^Live Preview$/,
      ),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('side-panel-header')).getAllByRole('button', {
        name: /Live Preview:\s*Web/i,
      })[0],
    ).toBeVisible();
  });

  it('posts iframe navigation messages for back, forward, reload, and manual path entry', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    const iframe = screen.getByTitle('Live Preview');
    const postMessageMock = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: postMessageMock,
      },
    });

    fireEvent.load(iframe);
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }));

    const input = screen.getByRole('textbox', { name: 'Preview path' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'settings?tab=2' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(postMessageMock).toHaveBeenNthCalledWith(
      1,
      { type: 'roomote-init', taskUrl: 'http://localhost:3000' },
      '*',
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(
      2,
      { type: 'roomote-nav-back' },
      '*',
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(
      3,
      { type: 'roomote-nav-forward' },
      '*',
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(
      4,
      { type: 'roomote-nav-reload' },
      '*',
    );
    expect(postMessageMock).toHaveBeenNthCalledWith(
      5,
      {
        type: 'roomote-nav-home',
        url: 'https://web.preview.test/settings?tab=2',
      },
      '*',
    );
  });

  it('clears the loading state when history navigation does not produce an iframe event', () => {
    vi.useFakeTimers();

    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(screen.getByText('loading')).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });

  it('syncs the preview path from iframe navigation events', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'roomote-navigation',
            url: 'https://web.preview.test/settings?tab=2#integrations',
          },
        }),
      );
    });

    expect(updatePreviewPathMock).toHaveBeenCalledWith(
      '/settings?tab=2#integrations',
    );
    expect(touchKeepaliveMutateMock).toHaveBeenCalled();
  });

  it('does not reopen the iframe when the iframe already navigated to the synced path', () => {
    const { rerender } = render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(openPreviewPaneMock).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'roomote-navigation',
            url: 'https://web.preview.test/settings?tab=2',
          },
        }),
      );
    });

    previewPathState = '/settings?tab=2';

    rerender(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(openPreviewPaneMock).not.toHaveBeenCalled();
  });

  it('reopens the iframe when the task route changes to a different preview path', () => {
    const { rerender } = render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    previewPathState = '/settings?tab=2';

    rerender(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    expect(openPreviewPaneMock).toHaveBeenCalledWith(
      'https://web.preview.test/settings?tab=2',
      123,
      'WEB',
    );
  });

  it('toggles the mobile preview viewport controls', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to mobile preview' }),
    );

    expect(screen.getByText('375 × 667')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Switch to desktop preview' }),
    ).toBeVisible();
  });

  it('retries the iframe when the preview never sends load-complete', () => {
    vi.useFakeTimers();

    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    const iframe = screen.getByTitle('Live Preview');
    const postMessageMock = vi.fn();
    const reloadMock = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: postMessageMock,
        location: {
          reload: reloadMock,
        },
      },
    });

    fireEvent.load(iframe);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      { type: 'roomote-init', taskUrl: 'http://localhost:3000' },
      '*',
    );
    expect(reloadMock).toHaveBeenCalled();
  });

  it('relays picked preview elements back onto the window', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    const pickedListener = vi.fn();
    window.addEventListener(
      'roomote-element-picked',
      pickedListener as EventListener,
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'roomote-element-picked',
            context: {
              element: 'button',
              url: 'https://web.preview.test/settings',
              path: 'button.primary',
              nearbyText: 'Save changes',
              cssClasses: 'primary',
              viewport: { width: 1280, height: 720 },
            },
          },
        }),
      );
    });

    const detail = pickedListener.mock.calls[0]?.[0]?.detail as
      | { text: string }
      | undefined;

    expect(detail?.text).toContain('[Element reference: button]');
    expect(detail?.text).toContain('URL: https://web.preview.test/settings');
    expect(detail?.text).toContain('Context: Save changes');

    window.removeEventListener(
      'roomote-element-picked',
      pickedListener as EventListener,
    );
  });

  it('allows restoring the preview widget after it is hidden', () => {
    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    const iframe = screen.getByTitle('Live Preview');
    const postMessageMock = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: postMessageMock,
      },
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'roomote-widget-hidden',
          },
        }),
      );
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Show preview widget' }),
    );

    expect(postMessageMock).toHaveBeenCalledWith(
      { type: 'roomote-widget-show' },
      '*',
    );
    expect(
      screen.queryByRole('button', { name: 'Show preview widget' }),
    ).not.toBeInTheDocument();
  });

  it('shows a services-starting notice while environment setup is running', () => {
    render(
      <PreviewSidePanel
        taskRun={
          {
            id: 123,
            taskId: 'task-1',
            environmentSetupState: 'running',
          } as never
        }
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Environment services are still starting/),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss preview starting notice' }),
    );

    expect(
      screen.queryByText(/Environment services are still starting/),
    ).not.toBeInTheDocument();
  });

  it('hides the services-starting notice once the preview reports loading', () => {
    render(
      <PreviewSidePanel
        taskRun={
          {
            id: 123,
            taskId: 'task-1',
            environmentSetupState: 'running',
          } as never
        }
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Environment services are still starting/),
    ).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'roomote-load-complete' },
        }),
      );
    });

    expect(
      screen.queryByText(/Environment services are still starting/),
    ).not.toBeInTheDocument();
  });

  it('does not show the services-starting notice when setup has completed', () => {
    render(
      <PreviewSidePanel
        taskRun={
          {
            id: 123,
            taskId: 'task-1',
            environmentSetupState: 'completed',
          } as never
        }
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/Environment services are still starting/),
    ).not.toBeInTheDocument();
  });

  it('announces a timed-out preview and provides guarded retry feedback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    render(
      <PreviewSidePanel
        taskRun={{ id: 123, taskId: 'task-1' } as never}
        onClose={vi.fn()}
      />,
    );

    const iframe = screen.getByTitle('Live Preview');
    const reloadMock = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: vi.fn(),
        location: { reload: reloadMock },
      },
    });

    fireEvent.load(iframe);
    act(() => {
      vi.advanceTimersByTime(300_001);
    });
    fireEvent.load(iframe);

    expect(screen.getByRole('status')).toHaveTextContent(
      "The preview hasn't reported loading",
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const retryButton = screen.getByRole('button', { name: /retrying/i });
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveAttribute('aria-busy', 'true');
    expect(reloadMock).toHaveBeenCalled();
  });
});
