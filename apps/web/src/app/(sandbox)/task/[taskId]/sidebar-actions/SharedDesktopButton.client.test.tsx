import { fireEvent, render, screen } from '@testing-library/react';

const { usePreviewUrlsMock, useTaskSidePanelMock, openSharedDesktopViewMock } =
  vi.hoisted(() => ({
    usePreviewUrlsMock: vi.fn(),
    useTaskSidePanelMock: vi.fn(),
    openSharedDesktopViewMock: vi.fn(),
  }));

vi.mock('../hooks/use-preview-urls', () => ({
  usePreviewUrls: usePreviewUrlsMock,
}));

vi.mock('../hooks/use-task-side-panel', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({
    label,
    onClick,
  }: {
    label: string;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

import { SharedDesktopButton } from './SharedDesktopButton';

describe('SharedDesktopButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreviewUrlsMock.mockReturnValue({
      previewUrls: {
        SHARED_DESKTOP: 'https://shared-desktop.preview.test',
      },
    });
    useTaskSidePanelMock.mockReturnValue({
      closeSidePanel: vi.fn(),
      isViewActive: vi.fn(() => false),
      openSharedDesktopView: openSharedDesktopViewMock,
    });
  });

  it('opens a dedicated Shared Desktop tab for environment tasks', () => {
    render(
      <SharedDesktopButton
        taskId="task-1"
        taskRun={{ payload: { environmentId: 'env-1' } } as never}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Shared Desktop' }));
    expect(openSharedDesktopViewMock).toHaveBeenCalledOnce();
  });

  it('does not appear for repository-only tasks', () => {
    render(
      <SharedDesktopButton
        taskId="task-1"
        taskRun={{ payload: {} } as never}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Shared Desktop' }),
    ).not.toBeInTheDocument();
  });
});
