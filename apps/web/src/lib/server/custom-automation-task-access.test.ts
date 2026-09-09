import {
  automations,
  customAutomations,
  db,
  environmentFactory,
  eq,
  runFactory,
  taskArtifacts,
  taskFactory,
  taskMessages,
  taskRunEvents,
  taskRuns,
  tasks,
  userFactory,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  RunStatus,
  TaskPayloadKind,
} from '@roomote/types';
import { enqueueTaskSleep } from '@roomote/sdk/server';
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
import { requestTaskRunSleepCommand } from '@/trpc/commands/snapshots';
import { getTaskPreviewStatusCommand } from '@/trpc/commands/preview-settings';
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
  enqueueTaskSleep: vi.fn(),
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
    const environment = await environmentFactory.create({
      createdByUserId: null,
      config: {
        name: 'Private preview',
        repositories: [{ repository: 'test/repo' }],
        ports: [{ name: 'WEB', port: 3000, primary: true }],
      },
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      vendor: 'modal',
      machineId: 'private-machine',
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'test/repo',
        environmentId: environment.id,
        description: 'Private task',
      },
      machineDomains: { WEB: 'private.preview.example.com' },
    });
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
      environment,
      automation: automation!,
      artifact: artifact!,
      ownerAuth,
      otherAuth,
      adminAuth: { ...otherAuth, isAdmin: true },
    };
  }

  describe('sleep and preview authorization', () => {
    beforeEach(() => {
      vi.mocked(enqueueTaskSleep).mockClear();
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('allows the automation owner and admin to sleep and read previews', async () => {
      const { task, run, environment, ownerAuth, adminAuth } = await fixture();
      for (const auth of [ownerAuth, adminAuth]) {
        await expect(
          requestTaskRunSleepCommand(auth, { runId: run.id }),
        ).resolves.toEqual({ success: true });
        await expect(
          getTaskPreviewStatusCommand(auth, { taskId: task.id }),
        ).resolves.toMatchObject({
          environment: { id: environment.id, portNames: ['WEB'] },
          runHasPreviewDomains: true,
        });
      }
      expect(enqueueTaskSleep).toHaveBeenCalledTimes(2);
      expect(enqueueTaskSleep).toHaveBeenCalledWith({ runId: run.id });
    });

    it('denies unrelated members without enqueueing sleep', async () => {
      const { run, otherAuth } = await fixture();
      const result = await requestTaskRunSleepCommand(otherAuth, {
        runId: run.id,
      });
      expect(enqueueTaskSleep).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: 'Task not found' });
    });

    it('denies unrelated members without disclosing preview information', async () => {
      const { task, otherAuth } = await fixture();
      await expect(
        getTaskPreviewStatusCommand(otherAuth, { taskId: task.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Task not found' });
    });

    it('checks access before disclosing machine state', async () => {
      const { run, otherAuth } = await fixture();
      await db
        .update(taskRuns)
        .set({ machineId: null })
        .where(eq(taskRuns.id, run.id));
      await expect(
        requestTaskRunSleepCommand(otherAuth, { runId: run.id }),
      ).resolves.toEqual({ success: false, error: 'Task not found' });
      expect(enqueueTaskSleep).not.toHaveBeenCalled();
    });

    it.each(['deleted', 'creatorless', 'absent', 'malformed'] as const)(
      'fails closed for %s automation provenance while preserving admin access',
      async (provenance) => {
        const { task, run, automation, ownerAuth, adminAuth } = await fixture();
        if (provenance === 'deleted') {
          await db
            .delete(customAutomations)
            .where(eq(customAutomations.id, automation.id));
        } else if (provenance === 'creatorless') {
          await db
            .update(customAutomations)
            .set({ createdByUserId: null })
            .where(eq(customAutomations.id, automation.id));
        } else {
          await db
            .update(tasks)
            .set({
              actorExternalId: provenance === 'absent' ? null : 'not-a-uuid',
            })
            .where(eq(tasks.id, task.id));
        }
        await expect(
          requestTaskRunSleepCommand(ownerAuth, { runId: run.id }),
        ).resolves.toEqual({ success: false, error: 'Task not found' });
        expect(enqueueTaskSleep).not.toHaveBeenCalled();
        await expect(
          getTaskPreviewStatusCommand(ownerAuth, { taskId: task.id }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          requestTaskRunSleepCommand(adminAuth, { runId: run.id }),
        ).resolves.toEqual({ success: true });
        await expect(
          getTaskPreviewStatusCommand(adminAuth, { taskId: task.id }),
        ).resolves.toMatchObject({ runHasPreviewDomains: true });
      },
    );

    it('preserves ordinary task collaboration', async () => {
      const { task, run, ownerAuth, otherAuth } = await fixture();
      await db
        .update(tasks)
        .set({
          initiatorKind: 'user',
          initiatorUserId: ownerAuth.userId,
          initiatorAutomation: null,
          actorExternalId: null,
        })
        .where(eq(tasks.id, task.id));
      await expect(
        requestTaskRunSleepCommand(otherAuth, { runId: run.id }),
      ).resolves.toEqual({ success: true });
      expect(enqueueTaskSleep).toHaveBeenCalledWith({ runId: run.id });
      await expect(
        getTaskPreviewStatusCommand(otherAuth, { taskId: task.id }),
      ).resolves.toMatchObject({ runHasPreviewDomains: true });
    });

    it('rejects missing tasks and runs without enqueueing sleep', async () => {
      const { ownerAuth } = await fixture();
      await expect(
        requestTaskRunSleepCommand(ownerAuth, { runId: -1 }),
      ).resolves.toEqual({ success: false, error: 'Task run not found' });
      expect(enqueueTaskSleep).not.toHaveBeenCalled();
      await expect(
        getTaskPreviewStatusCommand(ownerAuth, { taskId: 'missing-task' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

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

  it('limits member creator options to self and owned custom automations without changing admin options', async () => {
    const { task, automation, ownerAuth, otherAuth, adminAuth } =
      await fixture();
    const repositoryName = `filter-options/${task.id}`;
    await db.update(tasks).set({ repositoryName }).where(eq(tasks.id, task.id));
    const [otherAutomation, creatorlessAutomation] = await db
      .insert(customAutomations)
      .values([
        {
          name: 'Other automation',
          prompt: 'Report',
          createdByUserId: otherAuth.userId,
        },
        {
          name: 'Creatorless automation',
          prompt: 'Report',
          createdByUserId: null,
        },
      ])
      .returning();
    await db
      .insert(automations)
      .values({ key: 'sentry_triage' })
      .onConflictDoNothing();
    for (const initiatorUserId of [ownerAuth.userId, otherAuth.userId]) {
      await taskFactory.create({
        repositoryName,
        initiatorKind: 'user',
        initiatorUserId,
      });
    }
    for (const record of [otherAutomation!, creatorlessAutomation!]) {
      const automationTask = await taskFactory.create({
        repositoryName,
        initiatorKind: 'automation',
        initiatorAutomation: 'custom_automation',
        actorExternalId: record.id,
        actorDisplayName: record.name,
      });
      // Run-as identity must not substitute for creator ownership.
      await runFactory.create({
        taskId: automationTask.id,
        actingUserId: ownerAuth.userId,
      });
    }
    await taskFactory.create({
      repositoryName,
      initiatorKind: 'automation',
      initiatorAutomation: 'sentry_triage',
    });
    await taskFactory.create({
      repositoryName,
      initiatorKind: 'user',
      initiatorUserId: null,
      surface: 'slack',
      actorExternalId: 'external-member',
      actorDisplayName: 'External member',
    });
    const input = { repositoryName };
    const memberValues = (
      await getUsersOnlyForFilterCommand(ownerAuth, input)
    ).map((option) => option.value);
    expect(memberValues.sort()).toEqual(
      [
        ownerAuth.userId,
        `automation:custom_automation:${automation.id}`,
      ].sort(),
    );
    const adminValues = (
      await getUsersOnlyForFilterCommand(adminAuth, input)
    ).map((option) => option.value);
    expect(adminValues).toHaveLength(7);
    expect(adminValues).toEqual(
      expect.arrayContaining([
        ownerAuth.userId,
        otherAuth.userId,
        `automation:custom_automation:${automation.id}`,
        `automation:custom_automation:${otherAutomation!.id}`,
        `automation:custom_automation:${creatorlessAutomation!.id}`,
        'automation:sentry_triage',
      ]),
    );
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
