import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../(sandbox)/sessions/[sessionId]/SessionDeleteAction', () => ({
  SessionActions: () => (
    <button type="button" aria-label="More session actions" />
  ),
}));

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
          artifactCount: 2,
          singleArtifact: null,
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
          canManage: true,
        }}
      />,
    );

    expect(
      screen.getByRole('link', { name: /Update homepage background/ }),
    ).toHaveAttribute('href', '/sessions/session-1');
    expect(screen.getByText('Test User from Web')).toBeInTheDocument();
    expect(screen.queryByText(/started a session/)).not.toBeInTheDocument();
    expect(screen.getByText('$0.01')).toBeInTheDocument();
    fireEvent.focus(screen.getByText('$0.01'));
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
    expect(screen.getByRole('link', { name: '2 artifacts' })).toHaveAttribute(
      'href',
      '/sessions/session-1?panel=artifacts',
    );
    expect(screen.queryByText('Roomote')).not.toBeInTheDocument();
    expect(screen.queryByText('1 execution')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'More session actions' })
        .parentElement,
    ).toHaveClass('self-start');
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
          artifactCount: 0,
          singleArtifact: null,
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
      artifactCount: 0,
      singleArtifact: null,
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

  it('only renders attention indicators for needs-input and blocked states', () => {
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
      artifactCount: 0,
      singleArtifact: null,
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
          artifactCount: 0,
          singleArtifact: null,
          pullRequests: [],
          tasks: [],
        }}
      />,
    );

    expect(
      screen.getByText('Sentry Triage from Automation'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Sentry Triage').querySelector('img'),
    ).toBeInTheDocument();
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
      artifactCount: 0,
      singleArtifact: null,
      pullRequests: [],
      tasks: [],
    };

    const { rerender } = render(
      <SessionCard session={session} viewerUserId="other-user" />,
    );
    expect(screen.getByText('Same Display Name from Web')).toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();

    rerender(<SessionCard session={session} viewerUserId="owner-user" />);
    expect(screen.getByText('Same Display Name from Web')).toBeInTheDocument();
    expect(screen.getByLabelText('Same Display Name')).toHaveTextContent('SD');
    expect(screen.queryByText('Y')).not.toBeInTheDocument();
  });

  it('shows private and source metadata', () => {
    render(
      <SessionCard
        viewerUserId="user-1"
        session={{
          id: 'private-session',
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
          artifactCount: 0,
          singleArtifact: null,
          pullRequests: [],
          tasks: [],
        }}
      />,
    );

    expect(screen.getByLabelText('Private session')).toBeInTheDocument();
    expect(screen.getByText('Test User from Web')).toBeInTheDocument();
    expect(
      screen.queryByText(/started a private session/),
    ).not.toBeInTheDocument();
  });

  it('omits the output metadata line when there are no PRs or artifacts', () => {
    const { container } = render(
      <SessionCard
        viewerUserId="user-1"
        session={{
          id: 'session-compact',
          title: 'Compact session',
          ownerKind: 'user',
          ownerAutomation: null,
          ownerName: 'Bruno Bergher',
          ownerEmail: 'bruno@example.com',
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
          artifactCount: 0,
          singleArtifact: null,
          pullRequests: [],
          tasks: [],
        }}
      />,
    );

    expect(screen.getByText('Bruno Bergher from Web')).toBeInTheDocument();
    expect(container.querySelectorAll('.mt-2')).toHaveLength(0);
  });

  it.each([
    {
      owner: { taskId: null, path: 'notes/decision.md', version: 2 },
      expected: '/artifacts/session/session-one?path=notes%2Fdecision.md&v=2',
    },
    {
      owner: { taskId: 'task-1', path: 'reports/result.md', version: 3 },
      expected: '/artifacts/task/task-1?path=reports%2Fresult.md&v=3',
    },
  ])(
    'deep-links one artifact to its standalone viewer',
    ({ owner, expected }) => {
      render(
        <SessionCard
          viewerUserId="user-1"
          session={{
            id: 'session-one',
            title: 'One artifact',
            ownerKind: 'user',
            ownerAutomation: null,
            ownerName: 'Dan Riccio',
            ownerEmail: 'dan@example.com',
            ownerImageUrl: null,
            ownerUserId: 'user-1',
            privacy: 'shared',
            sourceSurface: 'slack',
            activityAt: Date.now() / 1000,
            cachedStatus: 'ready',
            executionCount: 1,
            inferenceCostMicroUsd: 0,
            directInferenceCostMicroUsd: 0,
            unread: false,
            artifactCount: 1,
            singleArtifact: owner,
            pullRequests: [],
            tasks: [],
          }}
        />,
      );

      expect(screen.getByText('Dan Riccio from Slack')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: '1 artifact' })).toHaveAttribute(
        'href',
        expected,
      );
    },
  );
});
