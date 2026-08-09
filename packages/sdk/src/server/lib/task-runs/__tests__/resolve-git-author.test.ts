import {
  db,
  githubUserMappings,
  repositoryFactory,
  taskFactory,
  type TaskRun,
  userFactory,
} from '@roomote/db/server';
import { ALL_REPOSITORIES, PRODUCT_NAME } from '@roomote/types';

import { resolveGitAuthor } from '../dequeue-helpers';

let githubUserIdSeed = Date.now() * 1000;
function uniqueGitHubUserId(): number {
  githubUserIdSeed += 1;
  return githubUserIdSeed;
}

function runContext(
  taskId: string,
  actingUserId: string | null,
  repo = 'Roomote/example-app',
) {
  return {
    id: 1,
    taskId,
    actingUserId,
    payload: {
      repo,
      sourceControlProvider: 'github',
    } as TaskRun['payload'],
  };
}

/**
 * resolveGitAuthor resolves a linked live acting user and falls back to
 * Roomote when a run has no current actor.
 */
describe('resolveGitAuthor', () => {
  it('returns the default Roomote identity when the commit author is unevaluated', async () => {
    const task = await taskFactory.create({});

    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, runContext(task.id, null)),
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
      resolveGitAuthor(tx, runContext(task.id, null)),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('uses the linked handle for an unknown-visibility GitHub workspace', async () => {
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
      resolveGitAuthor(tx, runContext(task.id, user.id)),
    );

    expect(result).toEqual({
      name: '@octocat',
      email: `${githubUserId}+octocat@users.noreply.github.com`,
    });
  });

  it('keeps the account name for a known private workspace', async () => {
    const user = await userFactory.create({ name: 'Mona Lisa' });
    const githubUserId = uniqueGitHubUserId();
    const repository = await repositoryFactory.create({
      fullName: `octo/private-${githubUserId}`,
      linkedByUserId: user.id,
      private: true,
      sourceControlProvider: 'gitlab',
    });
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
      resolveGitAuthor(tx, {
        ...runContext(task.id, user.id, repository.fullName),
        payload: {
          repo: repository.fullName,
          sourceControlProvider: 'gitlab',
        } as TaskRun['payload'],
      }),
    );

    expect(result).toEqual({
      name: 'Mona Lisa',
      email: `${githubUserId}+octocat@users.noreply.github.com`,
    });
  });

  it('uses Roomote for a public mixed-provider workspace', async () => {
    const user = await userFactory.create({ name: 'Mona Lisa' });
    const githubUserId = uniqueGitHubUserId();
    const privateRepository = await repositoryFactory.create({
      fullName: `group/private-${githubUserId}`,
      linkedByUserId: user.id,
      private: true,
      sourceControlProvider: 'gitea',
    });
    const publicRepository = await repositoryFactory.create({
      fullName: `group/public-${githubUserId}`,
      linkedByUserId: user.id,
      private: false,
      sourceControlProvider: 'gitlab',
    });
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
      resolveGitAuthor(tx, {
        ...runContext(task.id, user.id),
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: [
            privateRepository.fullName,
            publicRepository.fullName,
          ],
          sourceControlProvider: 'github',
        } as TaskRun['payload'],
      }),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
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
      resolveGitAuthor(tx, runContext(task.id, user.id)),
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
      resolveGitAuthor(tx, runContext(task.id, null)),
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
      resolveGitAuthor(tx, runContext(task.id, null)),
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
      resolveGitAuthor(tx, runContext(task.id, null)),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });

  it('does not require a task lookup when the run has no acting user', async () => {
    const result = await db.transaction(async (tx) =>
      resolveGitAuthor(tx, runContext('missing-task-id', null)),
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
      resolveGitAuthor(tx, runContext(task.id, participant.id)),
    );

    expect(result).toEqual({
      name: '@participant',
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
      resolveGitAuthor(tx, runContext(task.id, participant.id)),
    );

    expect(result).toEqual({
      name: PRODUCT_NAME,
      email: 'roomote@roomote.dev',
    });
  });
});
