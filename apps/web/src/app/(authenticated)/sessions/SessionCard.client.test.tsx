import { render, screen } from '@testing-library/react';

import { SessionCard } from './SessionCard';

describe('SessionCard', () => {
  it('links to the transcript without implicitly selecting execution details', () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        session={{
          id: 'session-1',
          title: 'Update homepage background',
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          ownerUserId: 'user-1',
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
  });

  it('shows a contextual matching transcript snippet', () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        query="heliotrope"
        session={{
          id: 'session-2',
          title: 'Prepare release notes',
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          ownerUserId: 'user-1',
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

  it('only shows unread activity for the session owner', () => {
    const session = {
      id: 'session-3',
      title: 'Review customer feedback',
      ownerName: 'Test User',
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      sourceSurface: 'web',
      activityAt: Date.now() / 1000,
      cachedStatus: 'ready' as const,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      unread: true,
      tasks: [],
    };

    const { rerender } = render(
      <SessionCard session={session} viewerUserId="user-2" />,
    );
    expect(screen.queryByLabelText('Unread activity')).not.toBeInTheDocument();

    rerender(<SessionCard session={session} viewerUserId="user-1" />);
    expect(screen.getByLabelText('Unread activity')).toBeInTheDocument();
  });

  it('renders the list and board status indicators', () => {
    const session = {
      id: 'session-4',
      title: 'Review status indicators',
      ownerName: 'Test User',
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      sourceSurface: 'web',
      activityAt: Date.now() / 1000,
      cachedStatus: 'active' as const,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      unread: false,
      tasks: [],
    };

    const { container, rerender } = render(
      <SessionCard session={session} viewerUserId="user-1" />,
    );
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('active')).not.toBeInTheDocument();
    expect(screen.getByText('Active')).toHaveClass('sr-only');

    rerender(
      <SessionCard
        session={{ ...session, cachedStatus: 'ready' }}
        viewerUserId="user-1"
      />,
    );
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();

    rerender(
      <SessionCard
        session={{ ...session, cachedStatus: 'needs_input' }}
        viewerUserId="user-1"
      />,
    );
    expect(screen.getByText('needs input')).toHaveClass('capitalize');

    rerender(
      <SessionCard
        session={{ ...session, cachedStatus: 'blocked' }}
        viewerUserId="user-1"
      />,
    );
    expect(screen.getByText('blocked')).toHaveClass('capitalize');
  });
});
