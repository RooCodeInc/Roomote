import { RunStatus, TaskPayloadKind } from '@roomote/types';

import {
  acknowledgeTaskResolution,
  clearTaskResolution,
  db,
  deriveLinkedPullRequestResolution,
  eq,
  isTaskResolutionEligible,
  lockTaskResolution,
  openTaskResolutionOnCloseout,
  resolveTaskResolutionFromLinkedPullRequests,
  taskFactory,
  taskPullRequests,
  taskRuns,
  tasks,
} from '../../server';
import type { CreateTaskRun } from '../../types';

async function readResolution(taskId: string) {
  const [task] = await db
    .select({
      status: tasks.resolutionStatus,
      updatedAt: tasks.resolutionUpdatedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return task;
}

async function linkPullRequest(
  taskId: string,
  prNumber: number,
  status: 'open' | 'draft' | 'merged' | 'closed' | null,
) {
  const repository = `owner/resolution-${taskId}`;
  const [pullRequest] = await db
    .insert(taskPullRequests)
    .values({
      taskId,
      sourceControlProvider: 'github',
      repository,
      prNumber,
      prUrl: `https://github.com/${repository}/pull/${prNumber}`,
      status,
    })
    .returning({ id: taskPullRequests.id });
  return pullRequest!;
}

async function insertRun(
  taskId: string,
  status: RunStatus,
  taskPhase: string | null,
) {
  await db.insert(taskRuns).values({
    taskId,
    payloadKind: TaskPayloadKind.StandardTask,
    payload: {
      description: 'task resolution fixture run',
    } as CreateTaskRun['payload'],
    status,
    taskPhase,
  });
}

describe('task resolution eligibility', () => {
  it.each([
    ['plan', false, true],
    ['implement', false, true],
    ['question', false, false],
    ['unknown', false, false],
    ['question', true, true],
    ['unknown', true, true],
  ] as const)(
    'classifies %s with linked PRs=%s as eligible=%s',
    (requestedWorkKind, hasLinkedPullRequests, expected) => {
      expect(
        isTaskResolutionEligible({
          requestedWorkKind,
          hasLinkedPullRequests,
        }),
      ).toBe(expected);
    },
  );

  it('aggregates only terminal linked PR statuses', () => {
    expect(deriveLinkedPullRequestResolution([])).toBeNull();
    expect(deriveLinkedPullRequestResolution(['merged', 'open'])).toBeNull();
    expect(deriveLinkedPullRequestResolution(['merged', null])).toBeNull();
    expect(deriveLinkedPullRequestResolution(['merged', 'merged'])).toBe(
      'acknowledged',
    );
    expect(deriveLinkedPullRequestResolution(['merged', 'closed'])).toBe(
      'needs_follow_up',
    );
  });
});

describe('task resolution persistence', () => {
  const taskIds: string[] = [];

  afterEach(async () => {
    while (taskIds.length > 0) {
      await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
    }
  });

  async function createTask(
    overrides: Parameters<typeof taskFactory.create>[0] = {},
  ) {
    const task = await taskFactory.create(overrides);
    taskIds.push(task.id);
    return task;
  }

  it('opens eligible closeouts and excludes questions and failed outcomes', async () => {
    const openedAt = new Date('2026-08-26T18:00:00.000Z');
    const task = await createTask({ requestedWorkKind: 'plan' });

    await expect(
      openTaskResolutionOnCloseout(task.id, { now: openedAt }),
    ).resolves.toBe(true);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: 'awaiting_confirmation',
      updatedAt: openedAt,
    });

    const question = await createTask({ requestedWorkKind: 'question' });
    await expect(openTaskResolutionOnCloseout(question.id)).resolves.toBe(
      false,
    );

    const failed = await createTask({
      requestedWorkKind: 'implement',
      state: 'failed',
    });
    await expect(openTaskResolutionOnCloseout(failed.id)).resolves.toBe(false);

    const blocked = await createTask({
      requestedWorkKind: 'implement',
      goalStatus: 'blocked',
    });
    await expect(openTaskResolutionOnCloseout(blocked.id)).resolves.toBe(false);
  });

  it('uses linked PRs as eligibility fallback and resolves terminal PRs', async () => {
    const task = await createTask({ requestedWorkKind: 'unknown' });
    await linkPullRequest(task.id, 1, 'merged');
    await linkPullRequest(task.id, 2, 'merged');
    const resolvedAt = new Date('2026-08-26T18:05:00.000Z');

    await expect(
      openTaskResolutionOnCloseout(task.id, { now: resolvedAt }),
    ).resolves.toBe(true);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: 'acknowledged',
      updatedAt: resolvedAt,
    });
  });

  it('acknowledges once, preserves the timestamp, and does not reopen', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    const acknowledgedAt = new Date('2026-08-26T18:10:00.000Z');
    await openTaskResolutionOnCloseout(task.id);

    await expect(
      acknowledgeTaskResolution(task.id, { now: acknowledgedAt }),
    ).resolves.toBe(true);
    await expect(
      acknowledgeTaskResolution(task.id, {
        now: new Date('2026-08-26T18:11:00.000Z'),
      }),
    ).resolves.toBe(false);
    await expect(openTaskResolutionOnCloseout(task.id)).resolves.toBe(false);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: 'acknowledged',
      updatedAt: acknowledgedAt,
    });
  });

  it.each([
    [RunStatus.Pending, null],
    [RunStatus.Running, null],
    [RunStatus.Running, 'running'],
    [RunStatus.Idle, 'running'],
  ] as const)(
    'does not acknowledge while the latest run is %s/%s',
    async (status, taskPhase) => {
      const task = await createTask({ requestedWorkKind: 'implement' });
      await openTaskResolutionOnCloseout(task.id);
      await insertRun(task.id, status, taskPhase);

      await expect(acknowledgeTaskResolution(task.id)).resolves.toBe(false);
      expect((await readResolution(task.id))?.status).toBe(
        'awaiting_confirmation',
      );
    },
  );

  it('uses only the latest run when deciding whether acknowledgement is safe', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    await openTaskResolutionOnCloseout(task.id);
    await insertRun(task.id, RunStatus.Running, 'running');
    await insertRun(task.id, RunStatus.Idle, 'waiting_for_prompt');

    await expect(acknowledgeTaskResolution(task.id)).resolves.toBe(true);
  });

  it('does not restore acknowledgement when a concurrent follow-up clears it', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    await openTaskResolutionOnCloseout(task.id);

    let releaseFollowUp!: () => void;
    const followUpCanCommit = new Promise<void>((resolve) => {
      releaseFollowUp = resolve;
    });
    let followUpHasCleared!: () => void;
    const followUpCleared = new Promise<void>((resolve) => {
      followUpHasCleared = resolve;
    });

    const followUp = db.transaction(async (tx) => {
      await clearTaskResolution(task.id, { executor: tx });
      await tx.insert(taskRuns).values({
        taskId: task.id,
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          description: 'concurrent follow-up fixture run',
        } as CreateTaskRun['payload'],
        status: RunStatus.Pending,
      });
      followUpHasCleared();
      await followUpCanCommit;
    });

    await followUpCleared;
    const acknowledgement = acknowledgeTaskResolution(task.id);
    releaseFollowUp();

    await expect(Promise.all([followUp, acknowledgement])).resolves.toEqual([
      undefined,
      false,
    ]);
    expect((await readResolution(task.id))?.status).toBeNull();
  });

  it('clears an old result before work and permits the next closeout cycle', async () => {
    const task = await createTask({ requestedWorkKind: 'plan' });
    await openTaskResolutionOnCloseout(task.id);
    await acknowledgeTaskResolution(task.id);
    const clearedAt = new Date('2026-08-26T18:15:00.000Z');

    await expect(
      clearTaskResolution(task.id, { now: clearedAt }),
    ).resolves.toBe(true);
    await expect(clearTaskResolution(task.id)).resolves.toBe(false);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: null,
      updatedAt: clearedAt,
    });
    await expect(openTaskResolutionOnCloseout(task.id)).resolves.toBe(true);
  });

  it('waits for every PR and marks closed-unmerged aggregates for follow-up', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    await linkPullRequest(task.id, 1, 'merged');
    const open = await linkPullRequest(task.id, 2, 'open');
    await openTaskResolutionOnCloseout(task.id);

    await expect(
      resolveTaskResolutionFromLinkedPullRequests(task.id),
    ).resolves.toBe(false);
    await db
      .update(taskPullRequests)
      .set({ status: 'closed' })
      .where(eq(taskPullRequests.id, open.id));
    const resolvedAt = new Date('2026-08-26T18:20:00.000Z');
    await expect(
      resolveTaskResolutionFromLinkedPullRequests(task.id, { now: resolvedAt }),
    ).resolves.toBe(true);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: 'needs_follow_up',
      updatedAt: resolvedAt,
    });

    const acknowledgedAt = new Date('2026-08-26T18:21:00.000Z');
    await expect(
      acknowledgeTaskResolution(task.id, { now: acknowledgedAt }),
    ).resolves.toBe(true);
    await expect(
      resolveTaskResolutionFromLinkedPullRequests(task.id),
    ).resolves.toBe(false);
    await expect(readResolution(task.id)).resolves.toEqual({
      status: 'acknowledged',
      updatedAt: acknowledgedAt,
    });
  });

  it('does not apply PR outcomes while a follow-up is active', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    await linkPullRequest(task.id, 1, 'merged');
    await openTaskResolutionOnCloseout(task.id);
    await clearTaskResolution(task.id);

    await expect(
      resolveTaskResolutionFromLinkedPullRequests(task.id),
    ).resolves.toBe(false);
    expect((await readResolution(task.id))?.status).toBeNull();
  });

  it('serializes concurrent terminal linked-PR aggregation per task', async () => {
    const task = await createTask({ requestedWorkKind: 'implement' });
    const first = await linkPullRequest(task.id, 1, 'open');
    const second = await linkPullRequest(task.id, 2, 'open');
    await openTaskResolutionOnCloseout(task.id);

    await Promise.all(
      [first.id, second.id].map((pullRequestId) =>
        db.transaction(async (tx) => {
          await lockTaskResolution(task.id, { executor: tx });
          await tx
            .update(taskPullRequests)
            .set({ status: 'closed' })
            .where(eq(taskPullRequests.id, pullRequestId));
          await resolveTaskResolutionFromLinkedPullRequests(task.id, {
            executor: tx,
          });
        }),
      ),
    );

    expect((await readResolution(task.id))?.status).toBe('needs_follow_up');
  });
});
