import { render, screen, within } from '@testing-library/react';

import { SESSION_STATUSES, getSessionStatusLabel } from '@roomote/types';

import SessionsPage from './page';

vi.mock('@/lib/server/auth-context', () => ({
  authorize: vi.fn().mockResolvedValue({ success: true, userId: 'user-1' }),
}));
vi.mock('./SessionsFilters', () => ({ SessionsFilters: () => null }));
vi.mock('@/lib/server/sessions', () => ({
  getSessionSources: vi.fn().mockResolvedValue([]),
  getSessions: vi.fn().mockResolvedValue({
    sessions: ['active', 'needs_input', 'blocked', null].map((status) => ({
      id: status ?? 'ready',
      title: `Review ${status ?? 'ready'} ${'long-unbroken-title'.repeat(20)}`,
      ownerKind: 'user',
      ownerAutomation: null,
      ownerName: 'Long display name '.repeat(10),
      ownerEmail: 'test@example.com',
      ownerImageUrl: null,
      ownerUserId: 'user-1',
      sourceSurface: 'web',
      activityAt: 1_788_000_000,
      cachedStatus: status,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: false,
      pullRequests: [1, 2, 3].map((number) => ({
        repository: `example/${'long-repository-name'.repeat(10)}`,
        number,
        url: `https://github.com/example/repo/pull/${number}`,
      })),
      tasks: [],
    })),
    nextCursor: 'older-cursor',
  }),
}));

describe('Sessions board', () => {
  it('keeps every status section and long-content link accessible, including older sessions', async () => {
    render(
      await SessionsPage({ searchParams: Promise.resolve({ view: 'board' }) }),
    );

    for (const status of SESSION_STATUSES) {
      const column = screen.getByRole('region', {
        name: getSessionStatusLabel(status),
      });
      expect(
        within(column).getByRole('link', {
          name: new RegExp(`Review ${status}`),
        }),
      ).toHaveAttribute('href', `/sessions/${status}`);
      for (const number of [1, 2, 3]) {
        expect(
          within(column).getByRole('link', { name: new RegExp(`#${number}$`) }),
        ).toHaveAttribute(
          'href',
          `https://github.com/example/repo/pull/${number}`,
        );
      }
    }
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?view=board&before=older-cursor');
  });
});
