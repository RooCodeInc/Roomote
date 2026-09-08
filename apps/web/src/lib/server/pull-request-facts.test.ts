import {
  db,
  eq,
  pullRequestFacts,
  repositories,
  repositoryFactory,
  userFactory,
  users,
} from '@roomote/db/server';

import { getRequestTimeBootstrapCutoff } from './analytics/time-buckets';
import { getStoredPullRequestsForAnalytics } from './pull-request-facts';

const cases = [
  ['America/Los_Angeles', '2026-09-07T02:00:00Z', '2026-09-06T07:00:00Z'],
  ['Asia/Tokyo', '2026-09-07T02:00:00Z', '2026-09-06T15:00:00Z'],
  ['America/Los_Angeles', '2026-03-08T12:00:00Z', '2026-03-08T08:00:00Z'],
  ['America/Los_Angeles', '2025-11-02T12:00:00Z', '2025-11-02T07:00:00Z'],
];

describe('PR analytics calendar-day cutoffs', () => {
  let repositoryId: string;
  let userId: string;

  beforeAll(async () => {
    const user = await userFactory.create();
    userId = user.id;
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitea',
      linkedByUserId: userId,
    });
    repositoryId = repository.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db
      .delete(pullRequestFacts)
      .where(eq(pullRequestFacts.repositoryId, repositoryId));
  });

  afterAll(async () => {
    await db.delete(repositories).where(eq(repositories.id, repositoryId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it.each(cases)(
    'filters stored PRs at local midnight in %s at %s',
    async (tz, timestamp, cutoff) => {
      vi.stubEnv('TZ', tz!);
      const start = new Date(cutoff!);
      await db.insert(pullRequestFacts).values(
        [-1, 0, 3600000].map((offset, index) => ({
          repositoryId,
          repositoryFullName: 'fixture/calendar-days',
          sourceControlProvider: 'gitea' as const,
          externalPullRequestId: index + 1,
          prNumber: index + 1,
          title: `Boundary ${index}`,
          htmlUrl: `https://example.invalid/pulls/${index + 1}`,
          state: 'open' as const,
          createdAtRemote: new Date(start.getTime() + offset),
          updatedAtRemote: new Date(start.getTime() + offset),
        })),
      );

      const rows = await getStoredPullRequestsForAnalytics({
        repositoryIds: [repositoryId],
        timePeriod: 1,
        now: new Date(timestamp!),
      });
      expect(rows.map((row) => row.number).sort()).toEqual([2, 3]);
      const allRows = await getStoredPullRequestsForAnalytics({
        repositoryIds: [repositoryId],
        timePeriod: 'all',
        now: new Date(timestamp!),
      });
      expect(allRows).toHaveLength(3);
    },
  );

  it.each(cases)(
    'bootstraps the same local day in %s at %s',
    (tz, timestamp, cutoff) => {
      vi.stubEnv('TZ', tz!);
      expect(getRequestTimeBootstrapCutoff(1, new Date(timestamp!))).toEqual(
        new Date(cutoff!),
      );
    },
  );

  it('does not bound an all-time or unspecified bootstrap', () => {
    expect(getRequestTimeBootstrapCutoff('all', new Date())).toBeNull();
    expect(getRequestTimeBootstrapCutoff(undefined, new Date())).toBeNull();
  });
});
