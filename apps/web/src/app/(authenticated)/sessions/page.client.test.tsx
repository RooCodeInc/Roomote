import { render, screen, within } from '@testing-library/react';

const { experimentState } = vi.hoisted(() => ({
  experimentState: { boardEnabled: false, judgmentEnabled: false },
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentExperiments: async () => ({
    sessionsBoard: experimentState.boardEnabled,
    sessionStatusJudgment: experimentState.judgmentEnabled,
  }),
}));

import SessionsPage from './page';

vi.mock('@/lib/server/auth-context', () => ({
  authorize: vi.fn().mockResolvedValue({ success: true, userId: 'user-1' }),
}));
vi.mock('./SessionsFilters', () => ({ SessionsFilters: () => null }));
vi.mock('@/lib/server/sessions', () => ({
  getSessionSources: vi.fn().mockResolvedValue([]),
  getSessions: vi.fn().mockResolvedValue({
    sessions: ['active', 'needs_input', 'blocked', null, 'done'].map(
      (status) => ({
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
        cachedStatus: status === 'done' ? 'ready' : status,
        judgedStatus: status === 'done' ? 'done' : null,
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
      }),
    ),
    nextCursor: 'older-cursor',
  }),
}));

describe('Sessions list', () => {
  beforeEach(() => {
    experimentState.boardEnabled = false;
    experimentState.judgmentEnabled = false;
  });

  it('keeps every session and long-content link accessible, including older sessions', async () => {
    render(await SessionsPage({ searchParams: Promise.resolve({}) }));

    for (const status of [
      'active',
      'needs_input',
      'blocked',
      'ready',
      'done',
    ]) {
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

  it('does not expose the board from a direct URL until the deployment flag is enabled', async () => {
    render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    expect(
      screen.queryByRole('heading', { name: 'done' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?before=older-cursor');
  });

  it('shows deployment-wide board lanes while preserving each Session card', async () => {
    experimentState.boardEnabled = true;
    experimentState.judgmentEnabled = true;

    render(
      await SessionsPage({
        searchParams: Promise.resolve({ view: 'board' }),
      }),
    );

    const doneSection = screen
      .getByRole('heading', { name: 'done' })
      .closest('section');
    expect(doneSection).not.toBeNull();
    expect(
      within(doneSection!).getByRole('link', { name: /Review done/ }),
    ).toHaveAttribute('href', '/sessions/done');
    expect(
      screen.getByRole('link', { name: 'Show older sessions' }),
    ).toHaveAttribute('href', '/sessions?view=board&before=older-cursor');
  });
});
