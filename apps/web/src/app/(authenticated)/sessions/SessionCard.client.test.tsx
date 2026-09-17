import { fireEvent, render, screen } from '@testing-library/react';

import { SessionCard } from './SessionCard';

describe('SessionCard', () => {
  it('links to the transcript without repository or execution metadata', async () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        session={{
          id: 'session-1',
          title: 'Update homepage background',
          ownerKind: 'user',
          ownerAutomation: null,
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          ownerUserId: 'user-1',
          privacy: 'shared',
          sourceSurface: 'web',
          activityAt: Date.now() / 1000,
          cachedStatus: 'active',
          executionCount: 1,
          inferenceCostMicroUsd: 10_000,
          directInferenceCostMicroUsd: 4_000,
          unread: false,
          pullRequests: [
            {
              repository: 'RooCodeInc/Roomote',
              number: 1939,
              url: 'https://github.com/RooCodeInc/Roomote/pull/1939',
            },
          ],
          tasks: [
            {
              taskId: 'task-1',
              title: 'Implement session totals',
              workflow: 'standard',
              repositoryName: 'RooCodeInc/Roomote',
              inferenceCostMicroUsd: 6_000,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole('link', { name: /Update homepage background/ }),
    ).toHaveAttribute('href', '/sessions/session-1');
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('started a session')).toBeInTheDocument();
    expect(screen.getByLabelText('Web')).toBeInTheDocument();
    expect(screen.queryByText('Web')).not.toBeInTheDocument();
    expect(screen.getByText('0.01')).toBeInTheDocument();
    fireEvent.focus(screen.getByText('0.01'));
    expect(
      (await screen.findAllByText('Inference cost breakdown')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('Direct session').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Implement session totals').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Roomote#1939' })).toHaveAttribute(
      'href',
      'https://github.com/RooCodeInc/Roomote/pull/1939',
    );
    expect(screen.queryByText('Roomote')).not.toBeInTheDocument();
    expect(screen.queryByText('1 execution')).not.toBeInTheDocument();
  });

  it('shows a contextual matching transcript snippet', () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        query="heliotrope"
        session={{
          id: 'session-2',
          title: 'Prepare release notes',
          ownerKind: 'user',
          ownerAutomation: null,
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          ownerUserId: 'user-1',
          privacy: 'shared',
          sourceSurface: 'web',
          activityAt: Date.now() / 1000,
          cachedStatus: 'ready',
          executionCount: 0,
          inferenceCostMicroUsd: 0,
          directInferenceCostMicroUsd: 0,
          unread: false,
          pullRequests: [],
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
      ownerKind: 'user' as const,
      ownerAutomation: null,
      ownerName: 'Test User',
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      privacy: 'shared' as const,
      sourceSurface: 'web',
      activityAt: Date.now() / 1000,
      cachedStatus: 'ready' as const,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: true,
      pullRequests: [],
      tasks: [],
    };

    const { rerender } = render(
      <SessionCard session={session} viewerUserId="user-2" />,
    );
    expect(screen.queryByLabelText('Unread activity')).not.toBeInTheDocument();

    rerender(<SessionCard session={session} viewerUserId="user-1" />);
    expect(screen.getByLabelText('Unread activity')).toBeInTheDocument();
  });

  it('only renders list and board indicators for attention states', () => {
    const session = {
      id: 'session-4',
      title: 'Review status indicators',
      ownerKind: 'user' as const,
      ownerAutomation: null,
      ownerName: 'Test User',
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      privacy: 'shared' as const,
      sourceSurface: 'web',
      activityAt: Date.now() / 1000,
      cachedStatus: 'active' as const,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: false,
      pullRequests: [],
      tasks: [],
    };

    const { container, rerender } = render(
      <SessionCard session={session} viewerUserId="user-1" />,
    );
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();

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

  it('labels automation-owned sessions with the automation actor', () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        session={{
          id: 'session-5',
          title: 'Triage recent errors',
          ownerKind: 'automation',
          ownerAutomation: 'sentry_triage',
          ownerName: null,
          ownerEmail: null,
          ownerImageUrl: null,
          ownerUserId: null,
          privacy: 'shared',
          sourceSurface: 'automation',
          activityAt: Date.now() / 1000,
          cachedStatus: 'ready',
          executionCount: 1,
          inferenceCostMicroUsd: 0,
          directInferenceCostMicroUsd: 0,
          unread: false,
          pullRequests: [],
          tasks: [],
        }}
      />,
    );

    expect(screen.getByText('Sentry Triage')).toBeInTheDocument();
    expect(screen.getByText('started a session')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Sentry Triage').querySelector('img'),
    ).toBeInTheDocument();
  });

  it('removes crowded attribution and source metadata only in board view', () => {
    render(
      <SessionCard
        view="board"
        viewerUserId="user-1"
        session={{
          id: 'session-board',
          title: 'Board session',
          ownerKind: 'user',
          ownerAutomation: null,
          ownerName: 'Test User',
          ownerEmail: 'test@example.com',
          ownerImageUrl: null,
          ownerUserId: 'user-1',
          privacy: 'shared',
          sourceSurface: 'slack',
          activityAt: Date.now() / 1000,
          cachedStatus: 'ready',
          executionCount: 0,
          inferenceCostMicroUsd: 0,
          directInferenceCostMicroUsd: 0,
          unread: false,
          pullRequests: [],
          tasks: [],
        }}
      />,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('started a session')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Slack')).toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
  });

  it('uses canonical identity for the viewer without changing other users', () => {
    const session = {
      id: 'session-identity',
      title: 'Identity labels',
      ownerKind: 'user' as const,
      ownerAutomation: null,
      ownerName: 'Same Display Name',
      ownerEmail: 'owner@example.com',
      ownerImageUrl: null,
      ownerUserId: 'owner-user',
      privacy: 'shared' as const,
      sourceSurface: 'web',
      activityAt: Date.now() / 1000,
      cachedStatus: 'ready' as const,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: false,
      pullRequests: [],
      tasks: [],
    };

    const { rerender } = render(
      <SessionCard session={session} viewerUserId="other-user" />,
    );
    expect(screen.getByText('Same Display Name')).toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();

    rerender(<SessionCard session={session} viewerUserId="owner-user" />);
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it.each(['list', 'board'] as const)(
    'shows private and source metadata in %s view',
    (view) => {
      render(
        <SessionCard
          view={view}
          viewerUserId="user-1"
          session={{
            id: `private-${view}`,
            title: 'Private planning',
            ownerKind: 'user',
            ownerAutomation: null,
            ownerName: 'Test User',
            ownerEmail: 'test@example.com',
            ownerImageUrl: null,
            ownerUserId: 'user-1',
            privacy: 'private',
            sourceSurface: 'web',
            activityAt: Date.now() / 1000,
            cachedStatus: 'ready',
            executionCount: 0,
            inferenceCostMicroUsd: 0,
            directInferenceCostMicroUsd: 0,
            unread: false,
            pullRequests: [],
            tasks: [],
          }}
        />,
      );

      expect(screen.getByLabelText('Private session')).toBeInTheDocument();
      expect(screen.getByLabelText('Web')).toBeInTheDocument();
      expect(screen.queryByText('Web')).not.toBeInTheDocument();
      if (view === 'list') {
        expect(
          screen.getByText('started a private session'),
        ).toBeInTheDocument();
      } else {
        expect(
          screen.queryByText('started a private session'),
        ).not.toBeInTheDocument();
      }
    },
  );
});
