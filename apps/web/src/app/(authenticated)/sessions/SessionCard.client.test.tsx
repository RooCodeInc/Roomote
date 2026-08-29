import { render, screen } from '@testing-library/react';

import { SessionCard } from './SessionCard';

describe('SessionCard', () => {
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
  });
});
