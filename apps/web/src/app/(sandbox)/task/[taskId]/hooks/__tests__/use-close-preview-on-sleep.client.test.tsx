import { renderHook } from '@testing-library/react';

import { usePreviewPane } from '../use-preview-pane';
import { useClosePreviewOnSleep } from '../use-close-preview-on-sleep';
import { useTaskSidePanel } from '../use-task-side-panel';

vi.mock('../use-preview-pane', () => ({
  usePreviewPane: vi.fn(),
}));

vi.mock('../use-task-side-panel', () => ({
  useTaskSidePanel: vi.fn(),
}));

const mockedUsePreviewPane = vi.mocked(usePreviewPane);
const mockedUseTaskSidePanel = vi.mocked(useTaskSidePanel);

function buildPreviewPaneContext(closePreviewPane: () => void) {
  return {
    previewPaneUrl: null,
    previewPaneRunId: null,
    previewPaneServiceName: null,
    openPreviewPane: vi.fn(),
    closePreviewPane,
    hasAutoOpened: false,
    setHasAutoOpened: vi.fn(),
  } as ReturnType<typeof usePreviewPane>;
}

function buildTaskSidePanelContext({
  closeSidePanel,
  isViewActive,
}: {
  closeSidePanel: () => void;
  isViewActive: (view: string) => boolean;
}) {
  return {
    hasProvider: true,
    activeView: null,
    artifactsMode: 'browser',
    selectedArtifactPath: null,
    selectedArtifactVersion: undefined,
    canGoToPreviousArtifact: false,
    canGoToNextArtifact: false,
    previewServiceName: null,
    previewPath: null,
    openPreviewView: vi.fn(),
    openPreviewSetupView: vi.fn(),
    openArtifactsBrowser: vi.fn(),
    openDiffView: vi.fn(),
    openArtifactDetail: vi.fn(),
    openTaskInfoView: vi.fn(),
    openTerminalView: vi.fn(),
    openLogsView: vi.fn(),
    closeSidePanel,
    goBackToArtifactsBrowser: vi.fn(),
    goToPreviousArtifact: vi.fn(),
    goToNextArtifact: vi.fn(),
    setArtifactVersion: vi.fn(),
    updatePreviewPath: vi.fn(),
    isViewActive,
  } as ReturnType<typeof useTaskSidePanel>;
}

describe('useClosePreviewOnSleep', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('closes preview and side panel when task is asleep and preview is active', () => {
    const closePreviewPane = vi.fn();
    const closeSidePanel = vi.fn();
    const isViewActive = vi.fn((view: string) => view === 'preview');

    mockedUsePreviewPane.mockReturnValue(
      buildPreviewPaneContext(closePreviewPane),
    );
    mockedUseTaskSidePanel.mockReturnValue(
      buildTaskSidePanelContext({ closeSidePanel, isViewActive }),
    );

    renderHook(() => useClosePreviewOnSleep(true));

    expect(closePreviewPane).toHaveBeenCalledTimes(1);
    expect(closeSidePanel).toHaveBeenCalledTimes(1);
  });

  it('does not close preview and side panel when preview view is not active', () => {
    const closePreviewPane = vi.fn();
    const closeSidePanel = vi.fn();

    mockedUsePreviewPane.mockReturnValue(
      buildPreviewPaneContext(closePreviewPane),
    );
    mockedUseTaskSidePanel.mockReturnValue(
      buildTaskSidePanelContext({
        closeSidePanel,
        isViewActive: vi.fn(() => false),
      }),
    );

    renderHook(() => useClosePreviewOnSleep(true));

    expect(closePreviewPane).not.toHaveBeenCalled();
    expect(closeSidePanel).not.toHaveBeenCalled();
  });
});
