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
 * resolveGitAuthor resolves a linked live acting user and falls back to
 * Roomote when a run has no current actor.
 */
describe('resolveGitAuthor', () => {
  it('returns the default Roomote identity when the commit author is unevaluated', async () => {
    const task = await taskFactory.create({});

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: null }),
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
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: null }),
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
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: user.id }),
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
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: user.id }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('falls back to Roomote when the run has no linked acting user', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: '12345',
      actorDisplayName: 'Octo Cat',
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: null }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('does not reuse an external launch identity without an acting user', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: '12345',
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: null }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('falls back to Roomote when the external identity is incomplete', async () => {
    const task = await taskFactory.create({
      commitAuthorKind: 'external',
      commitAuthorLogin: 'octocat',
      commitAuthorExternalId: null,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, { id: 1, taskId: task.id, actingUserId: null }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('does not require a task lookup when the run has no acting user', async () => {
    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, {
        id: 1,
        taskId: 'missing-task-id',
        actingUserId: null,
      }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('uses the live acting user instead of the launch-time author', async () => {
    const launchOwner = await userFactory.create({ name: 'Launch Owner' });
    const participant = await userFactory.create({ name: 'Participant' });
    const githubUserId = uniqueGitHubUserId();
    await db.insert(githubUserMappings).values({
      userId: participant.id,
      githubLogin: 'participant',
      githubUserId,
    });
    const task = await taskFactory.create({
      commitAuthorKind: 'user',
      commitAuthorUserId: launchOwner.id,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, {
        id: 1,
        taskId: task.id,
        actingUserId: participant.id,
      }),
    );

    expect(result).toEqual({
      name: 'Participant',
      email: `${githubUserId}+participant@users.noreply.github.com`,
    });
  });

  it('falls back to Roomote when the live acting user has no GitHub identity', async () => {
    const launchOwner = await userFactory.create({ name: 'Launch Owner' });
    const participant = await userFactory.create({
      name: 'Unlinked Participant',
    });
    const task = await taskFactory.create({
      commitAuthorKind: 'user',
      commitAuthorUserId: launchOwner.id,
    });

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, {
        id: 1,
        taskId: task.id,
        actingUserId: participant.id,
      }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });
});
