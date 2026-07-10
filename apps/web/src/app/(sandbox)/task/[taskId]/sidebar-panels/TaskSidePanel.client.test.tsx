import { render, screen } from '@testing-library/react';

const { useTaskSidePanelMock } = vi.hoisted(() => ({
  useTaskSidePanelMock: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useTaskSidePanel: useTaskSidePanelMock,
}));

vi.mock('./PreviewSidePanel', () => ({
  PreviewSidePanel: () => <div data-testid="preview-side-panel" />,
}));

vi.mock('./DiffSidePanel', () => ({
  DiffSidePanel: () => <div data-testid="diff-side-panel" />,
}));

vi.mock('./ArtifactsSidePanel', () => ({
  ArtifactsSidePanel: () => <div data-testid="artifacts-side-panel" />,
}));

vi.mock('./LogsSidePanel', () => ({
  LogsSidePanel: () => <div data-testid="logs-side-panel" />,
}));

vi.mock('./TaskInfoPanel', () => ({
  TaskInfoPanel: () => <div data-testid="task-info-panel" />,
}));

vi.mock('./TerminalSidePanel', () => ({
  TerminalSidePanel: () => <div data-testid="terminal-side-panel" />,
}));

import { TaskSidePanelDesktop } from './TaskSidePanel';

describe('TaskSidePanelDesktop', () => {
  const session = {
    taskRun: {
      id: 123,
    },
    sessionState: 'interactive',
    task: {
      id: 'task-1',
      title: 'Task title',
    },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    useTaskSidePanelMock.mockReturnValue({
      activeView: null,
      closeSidePanel: vi.fn(),
    });
  });

  it('does not mount the Live Preview panel while another side panel is active', () => {
    useTaskSidePanelMock.mockReturnValue({
      activeView: 'diff',
      closeSidePanel: vi.fn(),
    });

    render(
      <TaskSidePanelDesktop
        session={session}
        diffPanel={{
          data: undefined,
          error: null,
          isLoading: false,
          onRefresh: vi.fn(),
        }}
      />,
    );

    expect(screen.getByTestId('diff-side-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-side-panel')).not.toBeInTheDocument();
  });

  it('mounts the Live Preview panel only when the preview view is active', () => {
    useTaskSidePanelMock.mockReturnValue({
      activeView: 'preview',
      closeSidePanel: vi.fn(),
    });

    render(<TaskSidePanelDesktop session={session} />);

    expect(screen.getByTestId('preview-side-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-side-panel')).not.toBeInTheDocument();
  });
});
