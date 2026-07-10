import {
  db,
  githubUserMappings,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { PRODUCT_NAME } from '@roomote/types';

import { resolveGitAuthor } from '../dequeue-helpers';

let githubUserIdSeed = Date.now() * 1000;
function uniqueGitHubUserId(): number {
  githubUserIdSeed += 1;
  return githubUserIdSeed;
}

/**
 * resolveGitAuthor reads the persisted commit-author block off the run's
 * tasks row (commitAuthorKind/commitAuthorUserId/commitAuthorLogin/
 * commitAuthorExternalId) and resolves it to a git identity.
 */
describe('resolveGitAuthor', () => {
  it('returns the default Roomote identity when the commit author is unevaluated', async () => {
    const task = await taskFactory.create({});

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: 'Roomote',
      email: 'roomote@roomote.dev',
    });
  });

  it('returns the default Roomote identity for roomote commit authorship', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'roomote',
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('resolves a user commit author to their noreply email via the GitHub mapping', async () => {
    const user = await userFactory.create({ name: 'Mona Lisa' });
    const githubUserId = uniqueGitHubUserId();

    await db.insert(githubUserMappings).values({
      userId: user.id,
      githubLogin: 'octocat',
      githubUserId,
    });

    const task = await taskFactory.create({
      initiatorUserId: user.id,
      commitAuthorKind: 'user',
      commitAuthorUserId: user.id,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: 'Mona Lisa',
      email: `${githubUserId}+octocat@users.noreply.github.com`,
    });
  });

  it('falls back to Roomote when the user commit author has no GitHub mapping', async () => {
    const user = await userFactory.create({ name: 'Unmapped User' });

    const task = await taskFactory.create({
      initiatorUserId: user.id,
      commitAuthorKind: 'user',
      commitAuthorUserId: user.id,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('resolves an external commit author to the noreply email from the frozen identity', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: '12345',
      actorDisplayName: 'Octo Cat',
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: 'Octo Cat',
      email: '12345+octocat@users.noreply.github.com',
    });
  });

  it('falls back to the login as the display name for external authors without a display name', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: '12345',
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: 'octocat',
      email: '12345+octocat@users.noreply.github.com',
    });
  });

  it('falls back to Roomote when the external identity is incomplete', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: null,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('throws when the run points at a missing task', async () => {
    await expect(
      db.transaction(async (tx) =>
        resolveGitAuthor(tx, { id: 1, taskId: 'missing-task-id' }),
      ),
    ).rejects.toThrow(/not found/);
  });
});
