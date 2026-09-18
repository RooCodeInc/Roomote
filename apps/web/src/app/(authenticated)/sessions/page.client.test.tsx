import { render, screen } from '@testing-library/react';

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
      privacy: 'shared',
      sourceSurface: 'web',
      activityAt: 1_788_000_000,
      cachedStatus: status,
      executionCount: 0,
      inferenceCostMicroUsd: 0,
      directInferenceCostMicroUsd: 0,
      unread: false,
      artifactCount: 0,
      singleArtifact: null,
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

describe('Sessions list', () => {
  it('keeps every session and long-content link accessible, including older sessions', async () => {
    render(await SessionsPage({ searchParams: Promise.resolve({}) }));

    for (const status of ['active', 'needs_input', 'blocked', 'ready']) {
      expect(
        screen.getByRole('link', { name: new RegExp(`Review ${status}`) }),
      ).toHaveAttribute('href', `/sessions/${status}`);
    }
    for (const number of [1, 2, 3]) {
      expect(
        screen
          .getAllByRole('link', { name: new RegExp(`#${number}$`) })
          .some(
            (link) =>
              link.getAttribute('href') ===
              `https://github.com/example/repo/pull/${number}`,
          ),
      ).toBe(true);
    }
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?before=older-cursor');
  });
});
