import { fireEvent, render, screen } from '@testing-library/react';

import { CustomLink } from './custom-link';

const pushMock = vi.fn();
const openArtifactMock = vi.fn();
const openSessionArtifactViewerMock = vi.fn();

let mockPathname = '/task/task-1';
let mockArtifactLink: {
  openArtifact: (path: string, version?: number) => void;
} | null = { openArtifact: openArtifactMock };
let mockOpenSessionArtifactViewer: typeof openSessionArtifactViewerMock | null =
  null;

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks/ArtifactLinkProvider', () => ({
  useArtifactLink: () => mockArtifactLink,
}));

vi.mock(
  '@/app/(sandbox)/sessions/[sessionId]/session-task-panel-context',
  () => ({
    useOpenSessionArtifactViewer: () => mockOpenSessionArtifactViewer,
  }),
);

describe('CustomLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/task/task-1';
    mockArtifactLink = { openArtifact: openArtifactMock };
    mockOpenSessionArtifactViewer = null;
  });

  it('opens same-task absolute artifact links in the current task panel', () => {
    const href = `${window.location.origin}/task/task-1/artifacts/plans/demo-plan.md?v=2`;

    render(
      <CustomLink href={href} target="_blank" rel="noopener noreferrer">
        Open demo artifact
      </CustomLink>,
    );

    const link = screen.getByRole('link', { name: 'Open demo artifact' });
    expect(link).not.toHaveAttribute('target');

    fireEvent.click(link);

    expect(openArtifactMock).toHaveBeenCalledWith('plans/demo-plan.md', 2);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('opens query-based artifact links in the current task panel', () => {
    const href = `${window.location.origin}/task/task-1/artifacts?path=plans%2F.%2Fdemo-plan.md&v=2`;

    render(<CustomLink href={href}>Open legacy artifact</CustomLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Open legacy artifact' }));

    expect(openArtifactMock).toHaveBeenCalledWith('plans/./demo-plan.md', 2);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('navigates in-app for absolute artifact links to a different task', () => {
    const href = `${window.location.origin}/task/task-2/artifacts/plans/demo-plan.md?v=3`;

    render(<CustomLink href={href}>Other task artifact</CustomLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Other task artifact' }));

    expect(openArtifactMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(
      '/task/task-2/artifacts/plans/demo-plan.md?v=3',
      { scroll: false },
    );
  });

  it('opens Session artifact links in the Session side panel', () => {
    mockPathname = '/sessions/session-1';
    mockArtifactLink = null;
    mockOpenSessionArtifactViewer = openSessionArtifactViewerMock;
    const href = `${window.location.origin}/sessions/session-1?artifact=notes%2Fdecision.md&v=2`;

    render(<CustomLink href={href}>Open decision</CustomLink>);

    const link = screen.getByRole('link', { name: 'Open decision' });
    expect(link).not.toHaveAttribute('target');

    fireEvent.click(link);

    expect(openSessionArtifactViewerMock).toHaveBeenCalledWith({
      owner: { sessionId: 'session-1' },
      path: 'notes/decision.md',
      version: 2,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('opens task artifact links in the Session side panel when viewing a Session', () => {
    mockPathname = '/sessions/session-1';
    mockArtifactLink = null;
    mockOpenSessionArtifactViewer = openSessionArtifactViewerMock;
    const href = `${window.location.origin}/task/task-2/artifacts/plans/demo-plan.md?v=3`;

    render(<CustomLink href={href}>Task artifact</CustomLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Task artifact' }));

    expect(openSessionArtifactViewerMock).toHaveBeenCalledWith({
      owner: { taskId: 'task-2' },
      path: 'plans/demo-plan.md',
      version: 3,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('navigates in-app for Session artifact links outside that Session', () => {
    mockPathname = '/sessions/session-1';
    mockOpenSessionArtifactViewer = openSessionArtifactViewerMock;
    const href = `${window.location.origin}/sessions/session-2?artifact=notes%2Fdecision.md&v=1`;

    render(<CustomLink href={href}>Other session artifact</CustomLink>);

    const link = screen.getByRole('link', { name: 'Other session artifact' });
    expect(link).not.toHaveAttribute('target');

    fireEvent.click(link);

    expect(openSessionArtifactViewerMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith(
      '/sessions/session-2?artifact=notes%2Fdecision.md&v=1',
      { scroll: false },
    );
  });

  it('keeps external links opening in a new tab', () => {
    render(
      <CustomLink href="https://example.com/docs">External docs</CustomLink>,
    );

    const link = screen.getByRole('link', { name: 'External docs' });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
