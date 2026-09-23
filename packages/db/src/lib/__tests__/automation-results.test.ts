import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunStatus } from '@roomote/types';

import {
  automationResults,
  db,
  ensureAutomationRows,
  eq,
  recordAutomationResultForTask,
  recordBackgroundAutomationResult,
  recordSilentAutomationResultForRun,
  reconcileAutomationResultAcceptance,
  runFactory,
  taskFactory,
  taskPullRequests,
  taskRuns,
  tasks,
  workItems,
} from '../../server';

describe('automation result acceptance', () => {
  const taskIds: string[] = [];

  beforeAll(() => ensureAutomationRows(db));

  afterEach(async () => {
    for (const taskId of taskIds.splice(0)) {
      await db
        .delete(automationResults)
        .where(eq(automationResults.sourceTaskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });

  async function createAutomationTask(
    initiatorAutomation: typeof tasks.$inferSelect.initiatorAutomation = 'issue_fixer',
  ) {
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation,
      initiatorUserId: null,
    });
    taskIds.push(task.id);
    return task;
  }

  async function createResult(taskId: string, suffix: string) {
    const [result] = await db
      .insert(automationResults)
      .values({
        automationName: 'Issue Fixer',
        content: 'Report body',
        dedupeKey: `automation-result-acceptance:${taskId}:${suffix}`,
        sourceTaskId: taskId,
      })
      .returning();
    return result!;
  }

  async function createPullRequest(
    taskId: string,
    suffix: string,
    values: Partial<typeof taskPullRequests.$inferInsert> = {},
  ) {
    await db.insert(taskPullRequests).values({
      taskId,
      sourceControlProvider: 'github',
      host: 'github.com',
      prUrl: `https://github.com/roomote/test/pull/${suffix}`,
      prNumber: Number(suffix),
      repository: 'roomote/test',
      createdByRoomote: true,
      ...values,
    });
  }

  it('accepts a pending report at the sole deliverable PR merge time', async () => {
    const task = await createAutomationTask();
    const result = await createResult(task.id, 'qualifying');
    const mergedAt = new Date('2026-09-01T12:34:56.000Z');
    await createPullRequest(task.id, '1', { status: 'merged', mergedAt });

    await expect(reconcileAutomationResultAcceptance(task.id)).resolves.toBe(
      true,
    );
    await expect(reconcileAutomationResultAcceptance(task.id)).resolves.toBe(
      false,
    );

    const accepted = await db.query.automationResults.findFirst({
      where: eq(automationResults.id, result.id),
    });
    expect(accepted).toMatchObject({
      acceptedAt: mergedAt,
      acceptanceReason: 'pull_request_merged',
      ignoredAt: null,
    });
  });

  it('preserves explicit decisions and is idempotent for repeated reconciliation', async () => {
    const task = await createAutomationTask();
    const manuallyAcceptedAt = new Date('2026-08-01T00:00:00.000Z');
    const ignoredAt = new Date('2026-08-02T00:00:00.000Z');
    const accepted = await createResult(task.id, 'accepted');
    const ignored = await createResult(task.id, 'ignored');
    await db
      .update(automationResults)
      .set({ acceptedAt: manuallyAcceptedAt, acceptanceReason: 'manual' })
      .where(eq(automationResults.id, accepted.id));
    await db
      .update(automationResults)
      .set({ ignoredAt })
      .where(eq(automationResults.id, ignored.id));
    await createPullRequest(task.id, '2', {
      status: 'merged',
      mergedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(reconcileAutomationResultAcceptance(task.id)).resolves.toBe(
      false,
    );
    await expect(reconcileAutomationResultAcceptance(task.id)).resolves.toBe(
      false,
    );

    const rows = await db.query.automationResults.findMany({
      where: eq(automationResults.sourceTaskId, task.id),
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: accepted.id,
          acceptedAt: manuallyAcceptedAt,
          acceptanceReason: 'manual',
        }),
        expect.objectContaining({
          id: ignored.id,
          acceptedAt: null,
          ignoredAt,
        }),
      ]),
    );
  });

  it('excludes reference-only associations and tasks with multiple deliverable PRs', async () => {
    const unrelatedTask = await createAutomationTask();
    const unrelatedResult = await createResult(unrelatedTask.id, 'unrelated');
    expect(await reconcileAutomationResultAcceptance(unrelatedTask.id)).toBe(
      false,
    );

    const referenceTask = await createAutomationTask();
    const referenceResult = await createResult(referenceTask.id, 'reference');
    await createPullRequest(referenceTask.id, '3', {
      createdByRoomote: false,
      status: 'merged',
      mergedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(await reconcileAutomationResultAcceptance(referenceTask.id)).toBe(
      false,
    );

    const multiTask = await createAutomationTask();
    const multiResult = await createResult(multiTask.id, 'multi');
    await createPullRequest(multiTask.id, '4', {
      status: 'merged',
      mergedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await createPullRequest(multiTask.id, '5', { status: 'open' });
    expect(await reconcileAutomationResultAcceptance(multiTask.id)).toBe(false);

    const rows = await db.query.automationResults.findMany();
    expect(
      rows.find(({ id }) => id === unrelatedResult.id)?.acceptedAt,
    ).toBeNull();
    expect(
      rows.find(({ id }) => id === referenceResult.id)?.acceptedAt,
    ).toBeNull();
    expect(rows.find(({ id }) => id === multiResult.id)?.acceptedAt).toBeNull();
  });

  it('reconciles a merge that precedes report publication', async () => {
    const task = await createAutomationTask();
    const mergedAt = new Date('2026-09-01T10:20:30.000Z');
    await createPullRequest(task.id, '6', { status: 'merged', mergedAt });

    const result = await recordAutomationResultForTask({
      taskId: task.id,
      content: 'Published after merge',
      dedupeKey: `automation-result-acceptance:${task.id}:published`,
      visibility: 'shared',
    });

    expect(result).not.toBeNull();
    const accepted = await db.query.automationResults.findFirst({
      where: eq(automationResults.id, result!.id),
    });
    expect(accepted).toMatchObject({
      acceptedAt: mergedAt,
      acceptanceReason: 'pull_request_merged',
    });
  });

  it('clears a qualifying no-op at publication without clearing a substantive outcome', async () => {
    const task = await createAutomationTask('dependabot_triage');
    const empty = await recordAutomationResultForTask({
      taskId: task.id,
      content: 'No open alerts. No remediation work needed.',
      dedupeKey: `empty:${task.id}`,
      visibility: 'shared',
    });
    const substantive = await recordAutomationResultForTask({
      taskId: task.id,
      content: 'No open alerts in one repository. Access blocked for another.',
      dedupeKey: `substantive:${task.id}`,
      visibility: 'shared',
    });
    const inputRequest = await recordAutomationResultForTask({
      taskId: task.id,
      content: 'No open alerts.',
      dedupeKey: `input:${task.id}`,
      visibility: 'shared',
      resultKind: 'input_request',
    });

    expect(empty?.ignoredAt).toBeInstanceOf(Date);
    expect(substantive?.ignoredAt).toBeNull();
    expect(inputRequest?.ignoredAt).toBeNull();
  });

  it('persists a cleared outcome for a completed silent scan, once', async () => {
    const task = await createAutomationTask('codeql_triage');
    await db
      .update(tasks)
      .set({ state: 'completed' })
      .where(eq(tasks.id, task.id));
    const run = await runFactory.create({ taskId: task.id });
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, run.id));

    const result = await recordSilentAutomationResultForRun(run.id);
    expect(result).toMatchObject({
      automationKey: 'codeql_triage',
      sourceRunId: run.id,
      content: 'No output.',
      ignoredAt: expect.any(Date),
    });
    expect(await recordSilentAutomationResultForRun(run.id)).toBeNull();
    expect(
      await db.query.automationResults.findMany({
        where: eq(automationResults.sourceTaskId, task.id),
      }),
    ).toHaveLength(1);
  });

  it('persists a cleared taskless scheduler no-op', async () => {
    const result = await recordBackgroundAutomationResult({
      automationKey: 'code_quality_auditor',
      content: 'No merged PRs to audit.',
      dedupeKey: `no-pr-audit:${randomUUID()}`,
      visibility: 'shared',
    });
    expect(result?.ignoredAt).toBeInstanceOf(Date);
    if (result) {
      await db
        .delete(automationResults)
        .where(eq(automationResults.id, result.id));
    }
  });

  it('does not invent an empty outcome for a reported, actionable, unfinished, or unrelated run', async () => {
    for (const scenario of [
      'reported',
      'actionable',
      'unfinished',
      'unrelated',
    ] as const) {
      const task = await createAutomationTask(
        scenario === 'unrelated' ? 'security_auditor' : 'dependabot_triage',
      );
      await db
        .update(tasks)
        .set({ state: 'completed' })
        .where(eq(tasks.id, task.id));
      const run = await runFactory.create({ taskId: task.id });
      await db
        .update(taskRuns)
        .set({
          status:
            scenario === 'unfinished' ? RunStatus.Failed : RunStatus.Completed,
        })
        .where(eq(taskRuns.id, run.id));
      if (scenario === 'reported') {
        await recordAutomationResultForTask({
          taskId: task.id,
          content: 'Access blocked; scan incomplete.',
          dedupeKey: `reported:${task.id}`,
          visibility: 'shared',
        });
      }
      if (scenario === 'actionable') {
        await db.insert(workItems).values({
          kind: 'auto_fix',
          sourceTaskId: task.id,
          title: 'Fix alert',
          sortOrder: 0,
        });
      }
      expect(await recordSilentAutomationResultForRun(run.id)).toBeNull();
    }
  });
});
