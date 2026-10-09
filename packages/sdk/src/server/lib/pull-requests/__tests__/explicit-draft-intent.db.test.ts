import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  and,
  db,
  deploymentSettings,
  eq,
  githubInstallationFactory,
  githubInstallations,
  repositories,
  repositoryFactory,
  taskFactory,
  taskPullRequests,
  tasks,
  userFactory,
  users,
  type TaskRun,
} from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';

const { protocol } = vi.hoisted(() => ({
  protocol: {
    get: vi.fn(),
    update: vi.fn(),
    graphql: vi.fn(),
    lockAttempt: vi.fn(),
  },
}));
vi.mock('@roomote/auth', () => ({
  createGitHubToken: async () => 'test-token',
}));
vi.mock('@roomote/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/github')>()),
  getOctokit: () => ({ rest: { pulls: protocol }, graphql: protocol.graphql }),
}));
vi.mock('../pull-request-draft-intent', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../pull-request-draft-intent')>();
  return {
    ...actual,
    acquirePullRequestDraftTransitionLock: (
      ...args: Parameters<typeof actual.acquirePullRequestDraftTransitionLock>
    ) => {
      protocol.lockAttempt(...args);
      return actual.acquirePullRequestDraftTransitionLock(...args);
    },
  };
});

import { writeSourceControlPullRequestForTaskRun } from '../source-control-pull-request-writes';
import { markRoomotePullRequestReadyAfterCleanReview } from '../mark-roomote-pull-request-ready';
import { isPullRequestAutoReadyBlocked } from '../pull-request-draft-intent';
import { getRedis } from '@roomote/redis';

const head = '1234567890abcdef1234567890abcdef12345678';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('explicit draft intent with real persistence', () => {
  let repository: Awaited<ReturnType<typeof repositoryFactory.create>>;
  let task: Awaited<ReturnType<typeof taskFactory.create>>;
  let user: Awaited<ReturnType<typeof userFactory.create>>;
  let installation: Awaited<
    ReturnType<typeof githubInstallationFactory.create>
  >;
  let originalSettings: typeof deploymentSettings.$inferSelect | undefined;
  let draft: boolean;
  let remoteHead: string;

  beforeEach(async () => {
    originalSettings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
    });
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        metadata: {
          pr_action: 'draft',
          mark_roomote_pr_ready_after_clean_review: true,
        },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          metadata: {
            pr_action: 'draft',
            mark_roomote_pr_ready_after_clean_review: true,
          },
        },
      });
    user = await userFactory.create();
    installation = await githubInstallationFactory.create({
      installedByUserId: user.id,
    });
    repository = await repositoryFactory.create({
      installationId: installation.id,
      linkedByUserId: user.id,
      fullName: `draft-proof/${randomUUID()}`,
    });
    task = await taskFactory.create({ initiatorUserId: user.id });
    await db.insert(taskPullRequests).values({
      taskId: task.id,
      repositoryId: repository.id,
      repository: repository.fullName,
      prUrl: `${repository.htmlUrl}/pull/42`,
      prNumber: 42,
      createdByRoomote: true,
      status: 'draft',
    });
    draft = true;
    remoteHead = head;
    protocol.lockAttempt.mockClear();
    protocol.get.mockReset().mockImplementation(async () => ({
      data: {
        number: 42,
        node_id: 'PR_test',
        html_url: `${repository.htmlUrl}/pull/42`,
        state: 'open',
        draft,
        head: { sha: remoteHead },
      },
    }));
    protocol.update.mockReset().mockResolvedValue({
      data: { html_url: `${repository.htmlUrl}/pull/42` },
    });
    protocol.graphql.mockReset().mockImplementation(async (query: string) => {
      draft = query.includes('convertPullRequestToDraft');
      return {
        [draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview']:
          { pullRequest: { isDraft: draft, headRefOid: remoteHead } },
      };
    });
  });

  afterEach(async () => {
    await db.delete(tasks).where(eq(tasks.id, task.id));
    await db.delete(repositories).where(eq(repositories.id, repository.id));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installation.id));
    await db.delete(users).where(eq(users.id, user.id));
    if (originalSettings)
      await db
        .update(deploymentSettings)
        .set({ metadata: originalSettings.metadata })
        .where(eq(deploymentSettings.id, 'default'));
    else
      await db
        .delete(deploymentSettings)
        .where(eq(deploymentSettings.id, 'default'));
  });

  function updateDraft(value?: boolean) {
    return writeSourceControlPullRequestForTaskRun({
      taskRun: {
        id: 123,
        taskId: task.id,
        status: RunStatus.Dequeued,
        kind: 'fresh',
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: repository.fullName, sourceControlProvider: 'github' },
      } as TaskRun,
      input: {
        action: 'update_pull_request',
        repositoryFullName: repository.fullName,
        prNumber: 42,
        ...(value === undefined
          ? { title: 'Metadata update' }
          : { draft: value }),
      },
    });
  }

  function promote(reviewHead = remoteHead) {
    return markRoomotePullRequestReadyAfterCleanReview({
      sourceControlProvider: 'github',
      repository: repository.fullName,
      prNumber: 42,
      reviewHeadSha: reviewHead,
      reviewResult: { outcome: 'clean', findingCount: 0, headSha: reviewHead },
    });
  }

  it('keeps an explicitly requested draft after a clean review, even when the update was a no-op', async () => {
    await updateDraft(true);
    expect(protocol.graphql).not.toHaveBeenCalled();
    await promote();
    expect(draft).toBe(true);
    expect(protocol.graphql).not.toHaveBeenCalled();
    const association = await db.query.taskPullRequests.findFirst({
      where: and(
        eq(taskPullRequests.repositoryId, repository.id),
        eq(taskPullRequests.prNumber, 42),
      ),
    });
    expect(association?.status).toBe('draft');
  });

  it('preserves default promotion and lets an explicit ready request release the hold', async () => {
    await expect(promote()).resolves.toBe('marked_ready');
    expect(draft).toBe(false);
    await updateDraft(true);
    expect(draft).toBe(true);
    await expect(promote()).resolves.toBe('draft_requested');
    await updateDraft(false);
    expect(draft).toBe(false);
    expect(await isPullRequestAutoReadyBlocked(repository, 42)).toBe(false);
    // A subsequent remote draft/new review retains default automatic behavior.
    draft = true;
    await expect(promote()).resolves.toBe('marked_ready');
  });

  it('does not release intent after a failed ready request or a metadata-only refresh', async () => {
    await updateDraft(true);
    protocol.graphql.mockRejectedValueOnce(
      new Error('controlled provider failure'),
    );
    await expect(updateDraft(false)).rejects.toThrow(
      'controlled provider failure',
    );
    await updateDraft();
    await expect(promote()).resolves.toBe('draft_requested');
    expect(draft).toBe(true);
  });

  it('retains a hold when the provider fails to convert a ready PR to draft', async () => {
    draft = false;
    protocol.graphql.mockRejectedValueOnce(
      new Error('controlled provider failure'),
    );
    await expect(updateDraft(true)).rejects.toThrow(
      'controlled provider failure',
    );
    expect(await isPullRequestAutoReadyBlocked(repository, 42)).toBe(true);
    await expect(promote()).resolves.toBe('draft_requested');
    // Retry uses the actual update path and restores remote state.
    await updateDraft(true);
    expect(draft).toBe(true);
  });

  it('holds all current associations and a later review association cannot erase intent', async () => {
    const reviewTask = await taskFactory.create();
    try {
      await updateDraft(true);
      await db.insert(taskPullRequests).values({
        taskId: reviewTask.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        prUrl: `${repository.htmlUrl}/pull/42`,
        prNumber: 42,
        createdByRoomote: false,
      });
      await expect(promote()).resolves.toBe('draft_requested');
      remoteHead = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
      await expect(promote()).resolves.toBe('draft_requested');
      await updateDraft(false);
      const associations = await db.query.taskPullRequests.findMany({
        where: eq(taskPullRequests.repositoryId, repository.id),
      });
      expect(associations).toHaveLength(2);
      expect(associations.every((row) => !row.autoReadyBlocked)).toBe(true);
    } finally {
      await db.delete(tasks).where(eq(tasks.id, reviewTask.id));
    }
  });

  it('isolates a hold to the provider-scoped repository and PR number', async () => {
    await updateDraft(true);
    expect(await isPullRequestAutoReadyBlocked(repository, 43)).toBe(false);
    expect(
      await isPullRequestAutoReadyBlocked(
        { ...repository, id: randomUUID() },
        42,
      ),
    ).toBe(false);
    expect(
      await isPullRequestAutoReadyBlocked(
        { ...repository, sourceControlProvider: 'gitlab' },
        42,
      ),
    ).toBe(false);
  });

  it('serializes explicit draft behind an in-flight promotion and then retains the draft', async () => {
    const readStarted = deferred();
    const continueRead = deferred();
    const originalGet = protocol.get.getMockImplementation()!;
    protocol.get.mockImplementationOnce(async () => {
      readStarted.resolve();
      await continueRead.promise;
      return originalGet();
    });
    const promoting = promote();
    await readStarted.promise;
    const drafting = updateDraft(true);
    try {
      // A second owner cannot perform a read/mutation while promotion owns the lock.
      await expect
        .poll(async () =>
          getRedis().exists(
            `pr-review-synchronize:github:github.com:${repository.fullName}:42`,
          ),
        )
        .toBe(1);
      await expect.poll(() => protocol.lockAttempt.mock.calls.length).toBe(2);
      expect(protocol.get).toHaveBeenCalledTimes(1);
    } finally {
      continueRead.resolve();
    }
    await expect(promoting).resolves.toBe('marked_ready');
    await drafting;
    expect(draft).toBe(true);
    await expect(promote()).resolves.toBe('draft_requested');
  });

  it('shares lock ownership and durable intent with an independent process, then recovers', async () => {
    const helper = fileURLToPath(
      new URL('../pull-request-draft-intent.ts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      import { acquirePullRequestDraftTransitionLock, setPullRequestAutoReadyBlocked } from ${JSON.stringify(helper)};
      const release = await acquirePullRequestDraftTransitionLock(JSON.parse(process.env.DRAFT_PROOF_REPOSITORY), 42);
      try {
        await setPullRequestAutoReadyBlocked(JSON.parse(process.env.DRAFT_PROOF_REPOSITORY), 42, true);
        process.send('held');
        await new Promise(resolve => process.once('message', resolve));
      } finally { await release(); }
      process.exit(0);
    `,
      ],
      {
        env: {
          ...process.env,
          DRAFT_PROOF_REPOSITORY: JSON.stringify(repository),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stdout!.on('data', (data) => {
      output += data;
    });
    child.stderr!.on('data', (data) => {
      output += data;
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`child lock timeout: ${output}`)),
          15_000,
        );
        child.once('message', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`child exited ${code}: ${output}`));
        });
      });
      expect(await isPullRequestAutoReadyBlocked(repository, 42)).toBe(true);
      const readyRequest = updateDraft(false);
      // Controlled ordering: the child is the only owner until explicitly released.
      await expect.poll(() => protocol.lockAttempt.mock.calls.length).toBe(1);
      expect(protocol.graphql).not.toHaveBeenCalled();
      child.send('release');
      await expect(exited).resolves.toBe(0);
      await readyRequest;
      expect(await isPullRequestAutoReadyBlocked(repository, 42)).toBe(false);
      expect(draft).toBe(false);
      expect(
        await getRedis().exists(
          `pr-review-synchronize:github:github.com:${repository.fullName}:42`,
        ),
      ).toBe(0);
      // Reacquiring after independent owner cleanup remains functional.
      await updateDraft(true);
      await expect(promote()).resolves.toBe('draft_requested');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 30_000);
});
