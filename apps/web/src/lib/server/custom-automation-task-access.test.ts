import {
  automations,
  customAutomations,
  db,
  eq,
  runFactory,
  taskArtifacts,
  taskFactory,
  taskMessages,
  taskRunEvents,
  tasks,
  userFactory,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { getTasksCommand } from '@/trpc/commands/tasks/list';
import { getTaskByIdCommand } from '@/trpc/commands/tasks/by-id';
import { getTaskMessageEnvelopesCommand } from '@/trpc/commands/tasks/message-envelopes';
import { getTaskRunEventsCommand } from '@/trpc/commands/tasks/run-events';
import { updateTaskTitleCommand } from '@/trpc/commands/tasks/update-title';
import { deleteTasksCommand } from '@/trpc/commands/tasks/delete';
import { setTaskPinnedCommand } from '@/trpc/commands/tasks/pins';
import { getUsersOnlyForFilterCommand } from '@/trpc/commands/filters';
import { generateTaskSummaryCommand } from '@/trpc/commands/tasks/generate-summary';
import { getComposerSuggestionCommand } from '@/trpc/commands/tasks/composer-suggestion';
import { cancelTaskRunCommand } from '@/trpc/commands/task-runs';
import { retryFailedTaskStartCommand } from '@/trpc/commands/task-runs/retry-failed-start';
import { saveDraftPromptCommand } from '@/trpc/commands/sandbox-session';
import {
  getArtifactById,
  getArtifactByPath,
  getArtifactsForTask,
  getArtifactVersionsByPath,
} from './artifacts';
import { canAccessTask } from './custom-automation-task-access';

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  syncTaskCommunicationThreadTitleBestEffort: vi.fn(),
}));

describe('custom automation task history access', () => {
  async function fixture() {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    await db
      .insert(automations)
      .values({ key: 'custom_automation' })
      .onConflictDoNothing();
    const [automation] = await db
      .insert(customAutomations)
      .values({
        name: `Task access ${owner.id}`,
        prompt: 'Private report',
        createdByUserId: owner.id,
      })
      .returning();
    const task = await taskFactory.create({
      initiatorKind: 'automation',
      initiatorAutomation: 'custom_automation',
      actorExternalId: automation!.id,
      workflow: 'standard',
      visibility: 'visible',
    });
    const run = await runFactory.create({ taskId: task.id });
    await db.insert(taskMessages).values({
      runId: run.id,
      payload: {},
      taskId: task.id,
      userId: other.id,
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      ts: Date.now(),
      contentBlocks: [
        { type: 'text', text: 'Private automation conversation' },
      ],
    });
    await db.insert(taskRunEvents).values({
      taskId: task.id,
      runId: run.id,
      source: 'worker_runtime',
      eventType: 'diagnostic',
      message: 'Private diagnostic',
    });
    const [artifact] = await db
      .insert(taskArtifacts)
      .values({
        taskId: task.id,
        path: 'reports/result.txt',
        version: 1,
        uploaded: true,
        contentType: 'text/plain',
        size: 100,
      })
      .returning();
    const ownerAuth = { userId: owner.id, isAdmin: false } as UserAuthSuccess;
    const otherAuth = { userId: other.id, isAdmin: false } as UserAuthSuccess;
    return {
      task,
      run,
      automation: automation!,
      artifact: artifact!,
      ownerAuth,
      otherAuth,
      adminAuth: { ...otherAuth, isAdmin: true },
    };
  }

  it('applies live ownership independently of all/category/guessed creator filters', async () => {
    const { task, automation, ownerAuth, otherAuth, adminAuth } =
      await fixture();
    for (const filters of [
      [{ type: 'userId' as const, value: 'all', label: 'All' }],
      [{ type: 'category' as const, value: 'all', label: 'All' }],
      [
        {
          type: 'userId' as const,
          value: `automation:custom_automation:${automation.id}`,
          label: 'Guessed',
        },
      ],
    ]) {
      expect(
        (await getTasksCommand(otherAuth, { filters })).tasks.map((t) => t.id),
      ).not.toContain(task.id);
      for (const auth of [ownerAuth, adminAuth]) {
        expect(
          (await getTasksCommand(auth, { filters })).tasks.map((t) => t.id),
        ).toContain(task.id);
      }
    }
    const creator = `automation:custom_automation:${automation.id}`;
    expect(
      (await getUsersOnlyForFilterCommand(otherAuth, {})).map(
        (option) => option.value,
      ),
    ).not.toContain(creator);
    expect(
      (await getUsersOnlyForFilterCommand(ownerAuth, {})).map(
        (option) => option.value,
      ),
    ).toContain(creator);
    await db
      .update(customAutomations)
      .set({ createdByUserId: otherAuth.userId })
      .where(eq(customAutomations.id, automation.id));
    expect(await canAccessTask(ownerAuth, task.id)).toBe(false);
    expect(await canAccessTask(otherAuth, task.id)).toBe(true);
  });

  it('gates guessed detail, messages, events and artifact IDs despite participation', async () => {
    const { task, artifact, ownerAuth, otherAuth, adminAuth } = await fixture();
    await expect(
      getTaskByIdCommand(otherAuth, {
        taskId: task.id,
        includeArtifacts: true,
      }),
    ).resolves.toBeNull();
    await expect(
      getTaskByIdCommand(ownerAuth, { taskId: 'missing-task' }),
    ).resolves.toBeNull();
    await expect(
      getTaskMessageEnvelopesCommand(otherAuth, { taskId: task.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      getTaskRunEventsCommand(otherAuth, { taskId: task.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const auth of [otherAuth, { userId: null, isAdmin: false }]) {
      await expect(
        getArtifactById({ auth, taskId: task.id, artifactId: artifact.id }),
      ).resolves.toBeNull();
      await expect(
        getArtifactByPath({ auth, taskId: task.id, path: artifact.path }),
      ).resolves.toBeNull();
      await expect(
        getArtifactVersionsByPath({
          auth,
          taskId: task.id,
          path: artifact.path,
        }),
      ).resolves.toEqual([]);
      await expect(
        getArtifactsForTask({ auth, taskId: task.id }),
      ).resolves.toEqual([]);
    }
    for (const auth of [ownerAuth, adminAuth]) {
      await expect(
        getTaskByIdCommand(auth, { taskId: task.id, includeArtifacts: true }),
      ).resolves.toMatchObject({
        id: task.id,
        artifacts: [{ id: artifact.id }],
      });
      await expect(
        getTaskMessageEnvelopesCommand(auth, { taskId: task.id }),
      ).resolves.toHaveLength(1);
      await expect(
        getTaskRunEventsCommand(auth, { taskId: task.id }),
      ).resolves.toMatchObject({ events: [{ message: 'Private diagnostic' }] });
      await expect(
        getArtifactById({ auth, taskId: task.id, artifactId: artifact.id }),
      ).resolves.toMatchObject({ id: artifact.id });
      await expect(
        getArtifactByPath({ auth, taskId: task.id, path: artifact.path }),
      ).resolves.toMatchObject({ id: artifact.id });
      await expect(
        getArtifactVersionsByPath({
          auth,
          taskId: task.id,
          path: artifact.path,
        }),
      ).resolves.toHaveLength(1);
    }
  });

  it('fails closed for deleted, absent and malformed automation provenance', async () => {
    const { task, automation, ownerAuth, adminAuth } = await fixture();
    await db
      .delete(customAutomations)
      .where(eq(customAutomations.id, automation.id));
    for (const actorExternalId of [automation.id, null, 'not-a-uuid']) {
      await db
        .update(tasks)
        .set({ actorExternalId })
        .where(eq(tasks.id, task.id));
      expect(await canAccessTask(ownerAuth, task.id)).toBe(false);
      await expect(
        getTaskByIdCommand(ownerAuth, { taskId: task.id }),
      ).resolves.toBeNull();
      expect(await canAccessTask(adminAuth, task.id)).toBe(true);
    }
  });

  it('protects mutations and preserves ordinary collaborative reads and edits', async () => {
    const { task, run, ownerAuth, otherAuth } = await fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        generateTaskSummaryCommand(otherAuth, { taskId: task.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        getComposerSuggestionCommand(otherAuth, { taskId: task.id }),
      ).resolves.toEqual({ suggestion: null, messageCount: 0 });
      await expect(
        cancelTaskRunCommand(otherAuth, { taskId: task.id }),
      ).resolves.toMatchObject({ success: false, error: 'Task not found' });
      await expect(
        retryFailedTaskStartCommand(otherAuth, { taskId: task.id }),
      ).resolves.toMatchObject({ success: false, error: 'Task not found' });
      await expect(
        saveDraftPromptCommand(otherAuth, {
          runId: run.id,
          draftPrompt: 'Denied',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      errorLog.mockRestore();
    }
    await expect(
      updateTaskTitleCommand(otherAuth, { taskId: task.id, title: 'Denied' }),
    ).rejects.toThrow();
    await expect(
      setTaskPinnedCommand(otherAuth, { taskId: task.id, pinned: true }),
    ).resolves.toMatchObject({ error: 'task_not_found' });
    await expect(
      deleteTasksCommand(otherAuth, { taskIds: [task.id] }),
    ).resolves.toMatchObject({ deletedCount: 0 });
    expect(
      (await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) }))
        ?.deletedAt,
    ).toBeNull();
    await expect(
      updateTaskTitleCommand(ownerAuth, {
        taskId: task.id,
        title: 'Owner title',
      }),
    ).resolves.toMatchObject({ success: true });
    const ordinary = await taskFactory.create({
      initiatorUserId: ownerAuth.userId,
    });
    await runFactory.create({ taskId: ordinary.id });
    await expect(
      getTaskByIdCommand(otherAuth, { taskId: ordinary.id }),
    ).resolves.toMatchObject({ id: ordinary.id });
    await expect(
      getTaskMessageEnvelopesCommand(otherAuth, { taskId: ordinary.id }),
    ).resolves.toEqual([]);
    await expect(
      getTaskRunEventsCommand(otherAuth, { taskId: ordinary.id }),
    ).resolves.toEqual({ events: [] });
    await expect(
      updateTaskTitleCommand(otherAuth, {
        taskId: ordinary.id,
        title: 'Collaborative edit',
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      deleteTasksCommand(otherAuth, { taskIds: [ordinary.id] }),
    ).resolves.toMatchObject({ deletedCount: 1 });
  });
});
