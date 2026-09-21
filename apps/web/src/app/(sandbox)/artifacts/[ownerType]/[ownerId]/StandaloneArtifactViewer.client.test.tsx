import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { artifactQuery, replaceMock, viewerProps } = vi.hoisted(() => ({
  artifactQuery: {
    data: null as Record<string, unknown> | null,
    isPending: false,
    isError: false,
  },
  replaceMock: vi.fn(),
  viewerProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock('@/hooks/use-artifact-by-path', () => ({
  useArtifactByPath: vi.fn(() => artifactQuery),
}));

vi.mock('@/hooks/usePageTitle', () => ({
  usePageTitle: vi.fn(),
}));

vi.mock('@/components/tasks/ArtifactViewerContent', () => ({
  ArtifactViewerContent: (props: Record<string, unknown>) => {
    viewerProps.current = props;
    return <div>{props.emptyMessage as ReactNode}</div>;
  },
}));

vi.mock('@/components/system', () => ({
  ArrowUpRightIcon: () => <svg aria-hidden="true" />,
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Button: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { useArtifactByPath } from '@/hooks/use-artifact-by-path';
import { StandaloneArtifactViewer } from './StandaloneArtifactViewer';

describe('StandaloneArtifactViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    artifactQuery.data = null;
    artifactQuery.isPending = false;
    artifactQuery.isError = false;
    viewerProps.current = null;
  });

  it('loads and renders a task-owned artifact with source context', () => {
    artifactQuery.data = {
      id: 'artifact-1',
      taskId: 'task-1',
      path: 'reports/result.md',
      version: 2,
      artifactType: 'general',
      contentType: 'text/markdown',
      size: 10,
      createdAt: new Date('2026-09-19T00:00:00.000Z'),
      downloadUrl: '/download',
      content: '# Result',
    };

    render(
      <StandaloneArtifactViewer
        owner={{ taskId: 'task-1' }}
        path="reports/result.md"
        version={2}
      />,
    );

    expect(useArtifactByPath).toHaveBeenCalledWith(
      { taskId: 'task-1' },
      'reports/result.md',
      2,
    );
    expect(screen.getByRole('heading', { name: 'Result' })).toBeVisible();
    expect(screen.getByText('Version 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View in task' })).toHaveAttribute(
      'href',
      '/task/task-1/artifacts?path=reports%2Fresult.md&v=2',
    );
    expect(viewerProps.current?.artifact).toBe(artifactQuery.data);
  });

  it('handles loading, missing paths, unavailable artifacts, and version updates', () => {
    artifactQuery.isPending = true;
    const { rerender } = render(
      <StandaloneArtifactViewer
        owner={{ sessionId: 'session-1' }}
        path="proof/image.png"
      />,
    );
    expect(viewerProps.current?.isLoading).toBe(true);

    artifactQuery.isPending = false;
    artifactQuery.isError = true;
    rerender(
      <StandaloneArtifactViewer
        owner={{ sessionId: 'session-1' }}
        path="proof/image.png"
      />,
    );
    expect(screen.getByText('This artifact is unavailable.')).toBeVisible();

    const onVersionChange = viewerProps.current?.onVersionChange as (
      version: number,
    ) => void;
    onVersionChange(3);
    expect(replaceMock).toHaveBeenCalledWith(
      '/artifacts/session/session-1?path=proof%2Fimage.png&v=3',
    );

    rerender(
      <StandaloneArtifactViewer
        owner={{ sessionId: 'session-1' }}
        path={null}
      />,
    );
    expect(
      screen.getByText('This artifact link is missing a file path.'),
    ).toBeVisible();
  });
});
