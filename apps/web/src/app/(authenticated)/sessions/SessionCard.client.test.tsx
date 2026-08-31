import { render, screen } from '@testing-library/react';

const { routerPushMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({ repo }: { repo?: string }) => <span>{repo}</span>,
}));

import { SessionCard } from './SessionCard';

describe('SessionCard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('links to the transcript without implicitly selecting execution details', () => {
    render(
      <SessionCard
        session={{
          id: 'session-1',
          title: 'Update homepage background',
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          sourceSurface: 'web',
          activityAt: Date.now() / 1000,
          cachedStatus: 'active',
          executionCount: 1,
          inferenceCostMicroUsd: 0,
          unread: false,
          tasks: [
            {
              taskId: 'task-1',
              workflow: 'standard',
              repositoryName: 'RooCodeInc/Roomote',
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole('link', { name: /Update homepage background/ }),
    ).toHaveAttribute('href', '/sessions/session-1');
    expect(screen.getByText('started a session')).toBeInTheDocument();
  });

  it('shows a contextual matching transcript snippet', () => {
    render(
      <SessionCard
        query="heliotrope"
        session={{
          id: 'session-2',
          title: 'Prepare release notes',
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          sourceSurface: 'web',
          activityAt: Date.now() / 1000,
          cachedStatus: 'ready',
          executionCount: 0,
          inferenceCostMicroUsd: 0,
          unread: false,
          searchSnippet: '...preserve the Heliotrope detail before release.',
          tasks: [],
        }}
      />,
    );

    const match = screen.getByText('Heliotrope');
    expect(match).toHaveProperty('tagName', 'MARK');
    expect(match.parentElement).toHaveTextContent(
      '...preserve the Heliotrope detail before release.',
    );
  });
});
