import {
  db,
  eq,
  githubUserMappings,
  sql,
  userFactory,
  users,
} from '@roomote/db/server';

import { resolveGitHubUserAccessToken } from '../github-user-token';

describe('resolveGitHubUserAccessToken database coordination', () => {
  it('keeps concurrent refresh waits from exhausting the database pool', async () => {
    const user = await userFactory.create();
    const now = Date.now();
    await db.insert(githubUserMappings).values({
      githubLogin: `refresh-test-${crypto.randomUUID()}`,
      githubUserId: now * 1000 + Math.floor(Math.random() * 1000),
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(now - 1),
      userId: user.id,
    });

    vi.stubEnv('R_GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('R_GITHUB_CLIENT_SECRET', 'client-secret');
    let releaseOAuth!: (response: Response) => void;
    const oauthResponse = new Promise<Response>((resolve) => {
      releaseOAuth = resolve;
    });
    let oauthReleased = false;
    const fetchImpl = vi.fn<typeof fetch>(() => oauthResponse);

    try {
      const resolutions = Array.from({ length: 10 }, () =>
        resolveGitHubUserAccessToken(user.id, { fetchImpl, now }),
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      const unrelatedQueryResult = await Promise.race([
        db.execute(sql`select 1`).then(() => 'completed'),
        new Promise<'timed-out'>((resolve) =>
          setTimeout(() => resolve('timed-out'), 500),
        ),
      ]);
      expect(unrelatedQueryResult).toBe('completed');

      releaseOAuth(
        Response.json({
          access_token: 'refreshed-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 28_800,
        }),
      );
      oauthReleased = true;
      await expect(Promise.all(resolutions)).resolves.toEqual(
        Array(10).fill('refreshed-token'),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const mapping = await db.query.githubUserMappings.findFirst({
        where: eq(githubUserMappings.userId, user.id),
      });
      expect(mapping).toEqual(
        expect.objectContaining({
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          tokenRefreshClaim: null,
          tokenRefreshClaimedAt: null,
        }),
      );
    } finally {
      if (!oauthReleased) {
        releaseOAuth(new Response(null, { status: 503 }));
      }
      vi.unstubAllEnvs();
      await db
        .delete(githubUserMappings)
        .where(eq(githubUserMappings.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
