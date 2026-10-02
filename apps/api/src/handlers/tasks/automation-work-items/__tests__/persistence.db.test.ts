import { randomUUID } from 'node:crypto';

import {
  and,
  automations,
  db,
  eq,
  taskFactory,
  tasks,
  workItems,
} from '@roomote/db/server';

import { persistAutomationWorkItems } from '../persistence';
import type { PreparedAutomationWorkItem } from '../types';

describe('persistAutomationWorkItems (real database)', () => {
  const taskIds: string[] = [];

  afterEach(async () => {
    while (taskIds.length > 0) {
      await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
    }
  });

  it('deduplicates equal fingerprints within one submission', async () => {
    const sourceTask = await taskFactory.create();
    taskIds.push(sourceTask.id);
    await db
      .insert(automations)
      .values({ key: 'sentry_triage' })
      .onConflictDoNothing();
    const fingerprint = `same-batch-${randomUUID()}`;
    const prepared = {
      title: 'Fix duplicate launch',
      brief: 'One finding should launch one task.',
      category: 'bug',
      priority: 'P1',
      actionKind: 'code_change_pr',
      disposition: 'act',
      investigationContext: 'One logical finding.',
      executionPrompt: 'Fix the finding and open a pull request.',
      fingerprint,
      targetRepositoryFullName: 'acme/app',
      targetEnvironmentId: null,
      workspaceReadiness: 'bare_repo',
      readinessMessage: 'Bare repo launch.',
    } satisfies PreparedAutomationWorkItem;

    const result = await persistAutomationWorkItems({
      sourceTaskId: sourceTask.id,
      automationKey: 'sentry_triage',
      preparedWorkItems: [
        prepared,
        { ...prepared, title: 'Duplicate of the same finding' },
      ],
      repositoryIds: [],
    });

    const rows = await db
      .select({ id: workItems.id, title: workItems.title })
      .from(workItems)
      .where(
        and(
          eq(workItems.sourceTaskId, sourceTask.id),
          eq(workItems.fingerprint, fingerprint),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe(prepared.title);
    expect(result).toMatchObject({
      created: true,
      duplicateCount: 1,
      workItems: [{ id: rows[0]?.id, title: prepared.title }],
    });
  });
});
