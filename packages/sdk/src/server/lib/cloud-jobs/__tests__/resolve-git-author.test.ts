import type { CloudJob } from '@roomote/db/server';
import { db, githubUserMappings, userFactory } from '@roomote/db/server';
import { PRODUCT_NAME } from '@roomote/types';

import { resolveGitAuthor } from '../dequeue-helpers';

function makeCloudJob(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 1,
    payload: { repo: 'owner/repo' },
    githubLogin: null,
    githubUserId: null,
    userId: null,
    actingUserId: null,
    attributionKind: 'automatic',
    attributedUserId: null,
    attributionSourceKind: 'system',
    attributionSourceDisplayName: null,
    attributionSourceExternalId: null,
    attributedGithubLogin: null,
    attributedGithubUserId: null,
    ...overrides,
  } as CloudJob;
}

let githubUserIdSeed = Date.now() * 1000;
function uniqueGitHubUserId(): number {
  githubUserIdSeed += 1;
  return githubUserIdSeed;
}

describe('resolveGitAuthor', () => {
  it('returns default Roomote identity when no GitHub identity is linked', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(tx, makeCloudJob());
    });

    expect(result).toEqual({
      name: 'Roomote',
      email: 'roomote@roomote.dev',
    });
  });

  it('returns default when githubLogin is set but githubUserId is missing', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(tx, makeCloudJob({ githubLogin: 'testuser' }));
    });

    expect(result).toEqual({
      name: 'Roomote',
      email: 'roomote@roomote.dev',
    });
  });

  it('returns default when githubUserId is set but githubLogin is missing', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(tx, makeCloudJob({ githubUserId: 12345 }));
    });

    expect(result).toEqual({
      name: 'Roomote',
      email: 'roomote@roomote.dev',
    });
  });

  it('returns noreply email with githubLogin as name when userId is not set', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          attributionKind: 'unlinked_user',
          attributionSourceKind: 'github',
          attributionSourceDisplayName: 'octocat',
          attributionSourceExternalId: '12345',
          attributedGithubLogin: 'octocat',
          attributedGithubUserId: 12345,
        }),
      );
    });

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('falls back to the raw GitHub identity when a human effective author omits the numeric ID', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          attributionKind: 'unlinked_user',
          attributionSourceKind: 'github',
          attributionSourceDisplayName: 'octocat',
          attributionSourceExternalId: '12345',
          attributedGithubLogin: 'octocat',
          attributedGithubUserId: 12345,
          effectiveAuthorKind: 'human',
          effectiveAuthorDisplayName: 'octocat',
          effectiveAuthorGithubLogin: 'octocat',
          effectiveAuthorGithubUserId: null,
        }),
      );
    });

    expect(result).toEqual({
      name: 'octocat',
      email: '12345+octocat@users.noreply.github.com',
    });
  });

  it('uses the matched attribution user display name from the database', async () => {
    const user = await userFactory.create({ name: 'Mona Lisa' });
    const githubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values({
      userId: user.id,
      githubLogin: 'octocat',
      githubUserId,
    });

    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          userId: user.id,
          attributionKind: 'matched_user',
          attributedUserId: user.id,
          attributionSourceKind: 'web',
        }),
      );
    });

    expect(result).toEqual({
      name: 'Mona Lisa',
      email: `${githubUserId}+octocat@users.noreply.github.com`,
    });
  });

  it('prefers the effective human author when launch-time authorship overrides raw attribution', async () => {
    const user = await userFactory.create({ name: 'Assigned Author' });
    const githubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values({
      userId: user.id,
      githubLogin: 'assigned-author',
      githubUserId,
    });

    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          attributionKind: 'automatic',
          attributionSourceKind: 'automation',
          effectiveAuthorKind: 'human',
          effectiveAuthorUserId: user.id,
          effectiveAuthorDisplayName: 'Assigned Author',
          effectiveAuthorGithubLogin: 'assigned-author',
          effectiveAuthorGithubUserId: githubUserId,
        }),
      );
    });

    expect(result).toEqual({
      name: 'Assigned Author',
      email: `${githubUserId}+assigned-author@users.noreply.github.com`,
    });
  });

  it('falls back to Roomote when matched attribution user has no GitHub mapping', async () => {
    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          attributionKind: 'matched_user',
          attributedUserId: 'non-existent-user-id',
          attributionSourceKind: 'github',
          attributedGithubLogin: 'ghost',
        }),
      );
    });

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('uses linked GitHub mapping when matched attribution snapshot omits GitHub identity', async () => {
    const user = await userFactory.create({ name: 'John Richmond' });
    const githubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values({
      userId: user.id,
      githubLogin: 'jr',
      githubUserId,
    });

    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          userId: user.id,
          attributionKind: 'matched_user',
          attributedUserId: user.id,
          attributionSourceKind: 'web',
        }),
      );
    });

    expect(result).toEqual({
      name: 'John Richmond',
      email: `${githubUserId}+jr@users.noreply.github.com`,
    });
  });

  it('uses the matched attribution user instead of legacy owner fields', async () => {
    const owner = await userFactory.create({ name: 'Original Owner' });
    const replier = await userFactory.create({ name: 'Latest Replier' });
    const ownerGithubUserId = uniqueGitHubUserId();
    const replierGithubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values([
      {
        userId: owner.id,
        githubLogin: 'owner-login',
        githubUserId: ownerGithubUserId,
      },
      {
        userId: replier.id,
        githubLogin: 'replier-login',
        githubUserId: replierGithubUserId,
      },
    ]);

    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          userId: owner.id,
          actingUserId: replier.id,
          githubLogin: 'owner-login',
          githubUserId: ownerGithubUserId,
          attributionKind: 'matched_user',
          attributedUserId: replier.id,
          attributionSourceKind: 'github',
          attributedGithubLogin: 'replier-login',
        }),
      );
    });

    expect(result).toEqual({
      name: 'Latest Replier',
      email: `${replierGithubUserId}+replier-login@users.noreply.github.com`,
    });
  });

  it('does not fall back to legacy owner identity when the matched attribution user has no mapping', async () => {
    const owner = await userFactory.create({ name: 'Original Owner' });
    const replier = await userFactory.create({ name: 'Unlinked Replier' });
    const githubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values({
      userId: owner.id,
      githubLogin: 'owner-login',
      githubUserId,
    });

    const result = await db.transaction(async (tx) => {
      return resolveGitAuthor(
        tx,
        makeCloudJob({
          userId: owner.id,
          actingUserId: replier.id,
          githubLogin: 'owner-login',
          githubUserId,
          attributionKind: 'matched_user',
          attributedUserId: replier.id,
          attributionSourceKind: 'github',
        }),
      );
    });

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });
});
