import { eq } from 'drizzle-orm';

import { db, setupQualificationBlocks, userFactory } from '../../server';
import { syncSetupQualificationBlock } from '../setup-qualification-blocks';

describe('syncSetupQualificationBlock', () => {
  it('does not fail when concurrent first-time blocked writes race', async () => {
    const user = await userFactory.create({
      email: 'blocked@gmail.com',
    });

    const results = await Promise.all([
      syncSetupQualificationBlock({
        userId: user.id,
        reason: 'github_organization_required',
        blocked: true,
        snapshot: {
          githubAccountLogin: 'octocat',
          githubAccountType: 'User',
        },
      }),
      syncSetupQualificationBlock({
        userId: user.id,
        reason: 'github_organization_required',
        blocked: true,
        snapshot: {
          githubAccountLogin: 'octocat',
          githubAccountType: 'User',
        },
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeTruthy();
    expect(results[1]).toBeTruthy();

    const rows = await db
      .select({
        id: setupQualificationBlocks.id,
        status: setupQualificationBlocks.status,
      })
      .from(setupQualificationBlocks)
      .where(eq(setupQualificationBlocks.userId, user.id));

    expect(rows).toEqual([
      expect.objectContaining({
        status: 'blocked',
      }),
    ]);
  });
});
