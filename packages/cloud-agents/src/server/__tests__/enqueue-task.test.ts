// pnpm --filter @roomote/cloud-agents test src/server/__tests__/enqueue-task.test.ts
//
// Real-database integration tests for the Stage 2 enqueue rewrite: initiator
// stamping, resume semantics, enqueue-time PR linkage, and pr_review queue
// scope dedup.
import Redis from 'ioredis-mock';

const { mockGenerateLlmTaskTitle } = vi.hoisted(() => ({
  mockGenerateLlmTaskTitle: vi.fn().mockResolvedValue('Generated title'),
}));

vi.mock('../llm-task-title', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm-task-title')>()),
  generateLlmTaskTitle: mockGenerateLlmTaskTitle,
}));

import {
  ALL_REPOSITORIES,
  type TaskSpec,
  type SnapshotResumeTask,
  RunStatus,
  TaskPayloadKind,
  TASK_KICKOFF_MESSAGE_SOURCE,
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';
import {
  db,
  and,
  eq,
  inArray,
  tasks,
  taskRuns,
  taskMessages,
  taskPullRequests,
  taskRunEvents,
  deploymentSettings,
  users,
  environments,
  environmentRepositoryMappings,
  repositories,
  sessionTasks,
  userFactory,
  environmentFactory,
  repositoryFactory,
} from '@roomote/db/server';

import {
  TaskRunQueue,
  enqueueTask,
  enqueueTaskRelaunch,
  DeploymentReadOnlyError,
  SnapshotResumeAlreadyExistsError,
  persistEarlyGeneratedTaskTitle,
  PR_REVIEW_SYNC_DEBOUNCE_MS,
  resolveFreshTaskComputeProvider,
  resolvePrReviewQueuePolicy,
  resolveQueueScope,
  shouldCaptureActivationTaskCreatedEvent,
  shouldCaptureTaskCreatedEvent,
  type FreshTaskLaunch,
} from '../task-run-queue';
import { LLM_TITLE_LOCKED_CHECKPOINT } from '../llm-task-title';
import { applyTaskModelSelectionToRun } from '../task-model-selection';

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

const explicitWorkKind = {
  kind: 'implement',
  source: 'explicit_bootstrap',
  confidence: null,
} as const;

describe('resolveFreshTaskComputeProvider', () => {
  it('forces fresh launches onto Roomote in cloud-managed deployments', () => {
    expect(
      resolveFreshTaskComputeProvider('modal', 'docker', undefined, true),
    ).toBe('roomote');
  });

  it('keeps the requested provider outside cloud-managed deployments', () => {
    expect(
      resolveFreshTaskComputeProvider('modal', 'docker', undefined, false),
    ).toBe('modal');
  });

  it('keeps environment snapshots on their configured provider in cloud-managed deployments', () => {
    expect(
      resolveFreshTaskComputeProvider(
        'modal',
        'docker',
        TaskPayloadKind.SnapshotEnvironment,
        true,
      ),
    ).toBe('modal');
  });
});

describe('shouldCaptureTaskCreatedEvent', () => {
  it('excludes environment snapshot maintenance from task analytics', () => {
    expect(
      shouldCaptureTaskCreatedEvent(TaskPayloadKind.SnapshotEnvironment),
    ).toBe(false);
    expect(shouldCaptureTaskCreatedEvent(TaskPayloadKind.StandardTask)).toBe(
      true,
    );
  });
});

describe('shouldCaptureActivationTaskCreatedEvent', () => {
  const userInitiator = { kind: 'user', userId: 'user-1' } as const;

  it('includes only fresh, human-initiated standard tasks', () => {
    expect(
      shouldCaptureActivationTaskCreatedEvent({
        taskType: TaskPayloadKind.StandardTask,
        workflow: 'standard',
        initiator: userInitiator,
      }),
    ).toBe(true);
  });

  it.each([
    {
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'pr_review' as const,
      initiator: userInitiator,
    },
    {
      taskType: TaskPayloadKind.SnapshotEnvironment,
      workflow: 'env_snapshot' as const,
      initiator: userInitiator,
    },
    {
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'standard' as const,
      initiator: { kind: 'automation', key: 'dependabot_triage' } as const,
    },
    {
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'standard' as const,
      initiator: userInitiator,
      sourceRunId: 42,
    },
    {
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'standard' as const,
      initiator: userInitiator,
      environmentDefinitionId: 'environment-1',
    },
    {
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'standard' as const,
      initiator: userInitiator,
      verifiesEnvironmentId: 'environment-1',
    },
  ])('excludes non-activation task launches', (input) => {
    expect(shouldCaptureActivationTaskCreatedEvent(input)).toBe(false);
  });
});

function standardTaskInput(
  overrides: Partial<Extract<TaskSpec, { type: 'standard' }>> = {},
): Extract<TaskSpec, { type: 'standard' }> {
  return {
    type: TaskPayloadKind.StandardTask,
    requestedWorkKindDecision: explicitWorkKind,
    payload: {
      repo: 'acme/widgets',
      description: 'Do the thing',
    },
    ...overrides,
  } as Extract<TaskSpec, { type: 'standard' }>;
}

async function createUser(): Promise<string> {
  const user = await userFactory.create();
  createdUserIds.push(user.id);
  return user.id;
}

async function launchFresh(
  input: Omit<FreshTaskLaunch, 'task'> & {
    task?: FreshTaskLaunch['task'];
  },
) {
  const run = await enqueueTask(
    {
      task: standardTaskInput(),
      ...input,
    } as FreshTaskLaunch,
    { enqueue: false, skipEarlyTitleGeneration: true },
  );
  createdTaskIds.push(run.taskId);
  return run;
}

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db
      .delete(taskRunEvents)
      .where(inArray(taskRunEvents.taskId, createdTaskIds));
    await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    await db
      .delete(taskPullRequests)
      .where(inArray(taskPullRequests.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }

  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('enqueueTask initiator stamping', () => {
  it('persists an optional task goal on a fresh launch', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
      goal: {
        objective: 'Ship goal mode safely',
        maxContinuations: 4,
      },
    });

    await expect(
      db.query.tasks.findFirst({ where: eq(tasks.id, run.taskId) }),
    ).resolves.toMatchObject({
      goalObjective: 'Ship goal mode safely',
      goalLastContinuationId: expect.stringMatching(/^goal-generation:/),
      goalGenerationIds: [expect.stringMatching(/^goal-generation:/)],
      goalStatus: 'active',
      goalMaxContinuations: 4,
      goalContinuationsUsed: 0,
    });
  });

  it('blocks fresh launches when managed access is read-only', async () => {
    const priorSettings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { metadata: true },
    });
    const userId = await createUser();

    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        metadata: {
          feature_flags: { keep_me: true },
          deployment_disabled: false,
          managed_access: {
            state: 'read_only',
            reason: 'billing_required',
            revision: 7,
            effectiveAt: '2026-07-24T12:00:00.000Z',
            restrictionStartsAt: null,
            remediationUrl: 'https://cloud.roomote.test/#billing',
          },
        },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          metadata: {
            feature_flags: { keep_me: true },
            deployment_disabled: false,
            managed_access: {
              state: 'read_only',
              reason: 'billing_required',
              revision: 7,
              effectiveAt: '2026-07-24T12:00:00.000Z',
              restrictionStartsAt: null,
              remediationUrl: 'https://cloud.roomote.test/#billing',
            },
          },
        },
      });

    try {
      await expect(
        enqueueTask(
          {
            task: standardTaskInput(),
            initiator: { kind: 'user', userId },
            workflow: 'standard',
            surface: 'web',
            trigger: 'manual',
          },
          { enqueue: false },
        ),
      ).rejects.toBeInstanceOf(DeploymentReadOnlyError);
    } finally {
      await db
        .update(deploymentSettings)
        .set({ metadata: priorSettings?.metadata ?? {} })
        .where(eq(deploymentSettings.id, 'default'));
    }
  });

  it('rejects an early generated title after a user edit wins the database race', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });
    const editedAt = new Date();

    await db
      .update(tasks)
      .set({
        title: 'Manual title',
        titleEditedByUserAt: editedAt,
      })
      .where(eq(tasks.id, run.taskId));

    await expect(
      persistEarlyGeneratedTaskTitle({
        taskId: run.taskId,
        generatedTitle: 'Rejected generated title',
      }),
    ).resolves.toBe(false);

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: {
        title: true,
        titleEditedByUserAt: true,
        llmTitleCheckpoint: true,
      },
    });

    expect(task).toEqual({
      title: 'Manual title',
      titleEditedByUserAt: editedAt,
      llmTitleCheckpoint: 0,
    });
  });

  it('does not lock the first-message title checkpoint on a fallback title', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    await expect(
      persistEarlyGeneratedTaskTitle({
        taskId: run.taskId,
        generatedTitle: 'Untitled task',
      }),
    ).resolves.toBe(false);

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: {
        title: true,
        llmTitleCheckpoint: true,
      },
    });

    expect(task?.llmTitleCheckpoint).toBe(0);
    expect(task?.title).not.toBe('Untitled task');
  });

  it('can store an early title without locking checkpoint 1 for surface retries', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    await expect(
      persistEarlyGeneratedTaskTitle({
        taskId: run.taskId,
        generatedTitle: 'Surface-pending title',
        lockFirstMessageCheckpoint: false,
      }),
    ).resolves.toBe(true);

    const unlocked = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: {
        title: true,
        llmTitleCheckpoint: true,
      },
    });
    expect(unlocked).toEqual({
      title: 'Surface-pending title',
      llmTitleCheckpoint: 0,
    });

    await expect(
      persistEarlyGeneratedTaskTitle({
        taskId: run.taskId,
        generatedTitle: 'Surface-pending title',
        lockFirstMessageCheckpoint: true,
      }),
    ).resolves.toBe(true);

    const locked = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: {
        title: true,
        llmTitleCheckpoint: true,
      },
    });
    expect(locked).toEqual({
      title: 'Surface-pending title',
      llmTitleCheckpoint: 1,
    });
  });

  it('leaves checkpoint 0 open when the early-title surface callback fails', async () => {
    const userId = await createUser();
    mockGenerateLlmTaskTitle.mockResolvedValueOnce('Discord rename title');

    const run = await enqueueTask(
      {
        task: standardTaskInput(),
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'discord',
        trigger: 'message',
      },
      {
        enqueue: false,
        onEarlyTitleGenerated: async () => {
          throw new Error('rename failed');
        },
      },
    );
    createdTaskIds.push(run.taskId);

    await vi.waitFor(async () => {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, run.taskId),
        columns: {
          title: true,
          llmTitleCheckpoint: true,
        },
      });
      expect(task?.title).toBe('Discord rename title');
      expect(task?.llmTitleCheckpoint).toBe(0);
    });
  });

  it('locks checkpoint 1 after a successful early-title surface callback', async () => {
    const userId = await createUser();
    mockGenerateLlmTaskTitle.mockResolvedValueOnce('Renamed thread title');
    const onEarlyTitleGenerated = vi.fn().mockResolvedValue(undefined);

    const run = await enqueueTask(
      {
        task: standardTaskInput(),
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'discord',
        trigger: 'message',
      },
      {
        enqueue: false,
        onEarlyTitleGenerated,
      },
    );
    createdTaskIds.push(run.taskId);

    await vi.waitFor(async () => {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, run.taskId),
        columns: {
          title: true,
          llmTitleCheckpoint: true,
        },
      });
      expect(onEarlyTitleGenerated).toHaveBeenCalledWith({
        taskRun: expect.objectContaining({ taskId: run.taskId }),
        title: 'Renamed thread title',
      });
      expect(task).toEqual({
        title: 'Renamed thread title',
        llmTitleCheckpoint: 1,
      });
    });
  });

  it('generates an early title from a Slack app mention', async () => {
    const userId = await createUser();
    mockGenerateLlmTaskTitle.mockResolvedValueOnce(
      'Order more catnip from Amazon',
    );

    const run = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.SlackAppMention,
          requestedWorkKindDecision: explicitWorkKind,
          payload: {
            repo: 'acme/widgets',
            channel: 'C123',
            user: 'U123',
            text: 'Could you order more catnip from Amazon?',
            ts: '123.456',
            thread_ts: '123.456',
          },
        },
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'slack',
        trigger: 'message',
      },
      { enqueue: false },
    );
    createdTaskIds.push(run.taskId);

    await vi.waitFor(async () => {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, run.taskId),
        columns: { title: true, llmTitleCheckpoint: true },
      });

      expect(mockGenerateLlmTaskTitle).toHaveBeenCalledWith({
        userId,
        taskId: run.taskId,
        messages: [
          {
            role: 'user',
            text: 'Could you order more catnip from Amazon?',
          },
        ],
      });
      expect(task).toEqual({
        title: 'Order more catnip from Amazon',
        llmTitleCheckpoint: 1,
      });
    });
  });

  it('re-applies the newer canonical title when the checkpoint lock loses a race', async () => {
    const userId = await createUser();
    mockGenerateLlmTaskTitle.mockResolvedValueOnce('Early generated title');
    let taskId = '';
    const onEarlyTitleGenerated = vi.fn(
      async ({ title }: { title: string }) => {
        if (title === 'Early generated title' && taskId) {
          await db
            .update(tasks)
            .set({
              title: 'First-message refresh title',
              llmTitleCheckpoint: 1,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, taskId));
        }
      },
    );

    const run = await enqueueTask(
      {
        task: standardTaskInput(),
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'discord',
        trigger: 'message',
      },
      {
        enqueue: false,
        onEarlyTitleGenerated,
      },
    );
    taskId = run.taskId;
    createdTaskIds.push(run.taskId);

    await vi.waitFor(() => {
      expect(onEarlyTitleGenerated).toHaveBeenCalledWith({
        taskRun: expect.objectContaining({ taskId: run.taskId }),
        title: 'Early generated title',
      });
      expect(onEarlyTitleGenerated).toHaveBeenCalledWith({
        taskRun: expect.objectContaining({ taskId: run.taskId }),
        title: 'First-message refresh title',
      });
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: {
        title: true,
        llmTitleCheckpoint: true,
      },
    });
    expect(task).toEqual({
      title: 'First-message refresh title',
      llmTitleCheckpoint: 1,
    });
  });

  it('persists an intentional pre-dispatch phase and error', async () => {
    const userId = await createUser();

    const run = await enqueueTask(
      {
        task: standardTaskInput(),
        title: 'Set up your first environment',
        initiator: { kind: 'user', userId },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      },
      {
        enqueue: false,
        initialTaskPhase: 'waiting_for_sandbox_provider',
        initialError: 'Provisioning needs attention.',
      },
    );
    createdTaskIds.push(run.taskId);

    expect(run.taskPhase).toBe('waiting_for_sandbox_provider');
    expect(run.error).toBe('Provisioning needs attention.');
  });

  it('persists and locks an explicit title at task creation', async () => {
    const userId = await createUser();

    mockGenerateLlmTaskTitle.mockClear();
    const run = await enqueueTask(
      {
        task: standardTaskInput(),
        title: 'Set up your first environment',
        initiator: { kind: 'user', userId },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      },
      { enqueue: false },
    );
    createdTaskIds.push(run.taskId);

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
      columns: { title: true, llmTitleCheckpoint: true },
    });

    expect(task).toEqual({
      title: 'Set up your first environment',
      llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT,
    });
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('persists a linked-user initiator with CHECK-valid shape', async () => {
    const userId = await createUser();

    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task).toBeDefined();
    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBe(userId);
    expect(task!.initiatorAutomation).toBeNull();
    expect(task!.workflow).toBe('standard');
    expect(task!.surface).toBe('web');
    expect(task!.trigger).toBe('manual');
    expect(task!.visibility).toBe('visible');
    expect(task!.state).toBe('active');
    // Commit author evaluated unconditionally: linked user -> 'user'.
    expect(task!.commitAuthorKind).toBe('user');
    expect(task!.commitAuthorUserId).toBe(userId);

    expect(run.kind).toBe('fresh');
    expect(run.payloadKind).toBe('standard');
    expect(run.actingUserId).toBe(userId);
    expect(run.sourceRunId).toBeNull();
  });

  it('persists the launching run pointer on the fresh run row', async () => {
    const userId = await createUser();

    const parentRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const childRun = await launchFresh({
      task: standardTaskInput({
        sourceRunId: parentRun.id,
        payload: {
          repo: 'acme/widgets',
          description: 'Verify the environment',
          notifySourceRunOnSettle: true,
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    expect(childRun.sourceRunId).toBe(parentRun.id);
    expect(
      (childRun.payload as { notifySourceRunOnSettle?: boolean })
        .notifySourceRunOnSettle,
    ).toBe(true);
  });

  it('inherits source communication metadata for child task launches', async () => {
    const userId = await createUser();
    const parentRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
      channels: { slackChannelId: 'C123', slackThreadTs: '123.456' },
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Parent work',
          communicationProvider: 'slack',
          communicationChannelId: 'C123',
          communicationThreadId: '123.456',
        },
      }),
    });

    const childRun = await launchFresh({
      task: {
        ...standardTaskInput({
          payload: { repo: 'acme/widgets', description: 'Child work' },
        }),
        communicationContextSourceRunId: parentRun.id,
      },
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    expect(childRun.payload).toMatchObject({
      communicationProvider: 'slack',
      communicationChannelId: 'C123',
      communicationThreadId: '123.456',
      communicationContextInherited: true,
    });
    expect(childRun.sourceRunId).toBeNull();
  });

  it('keeps a launch with its own live communication context untouched', async () => {
    const userId = await createUser();
    const parentRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
      channels: { slackChannelId: 'C123', slackThreadTs: '123.456' },
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Parent work',
          communicationProvider: 'slack',
          communicationChannelId: 'C123',
          communicationThreadId: '123.456',
        },
      }),
    });

    const childRun = await launchFresh({
      task: {
        ...standardTaskInput({
          payload: {
            repo: 'acme/widgets',
            description: 'Child work',
            communicationProvider: 'teams',
            communicationChannelId: '19:live@thread.v2',
            communicationThreadId: 'live-activity',
          },
        }),
        communicationContextSourceRunId: parentRun.id,
      },
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    expect(childRun.payload).toMatchObject({
      communicationProvider: 'teams',
      communicationChannelId: '19:live@thread.v2',
      communicationThreadId: 'live-activity',
    });
    expect(
      (childRun.payload as Record<string, unknown>)
        .communicationContextInherited,
    ).toBeUndefined();
  });

  it('persists an unlinked external actor with actor context and external commit author', async () => {
    const run = await launchFresh({
      task: standardTaskInput({
        githubLogin: 'octofan',
        githubUserId: 987654,
      }),
      initiator: {
        kind: 'user',
        externalId: 'U12345',
        displayName: 'Octo Fan',
      },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
      channels: {
        slackChannelId: 'C42',
        slackThreadTs: '1234.5678',
      },
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBeNull();
    expect(task!.initiatorAutomation).toBeNull();
    expect(task!.actorExternalId).toBe('U12345');
    expect(task!.actorDisplayName).toBe('Octo Fan');
    expect(task!.slackChannelId).toBe('C42');
    expect(task!.slackThreadTs).toBe('1234.5678');
    // Unlinked human with a GitHub identity -> 'external' with login + id.
    expect(task!.commitAuthorKind).toBe('external');
    expect(task!.commitAuthorLogin).toBe('octofan');
    expect(task!.commitAuthorExternalId).toBe('987654');
    expect(task!.prAssigneeLogin).toBe('octofan');

    expect(run.actingUserId).toBeNull();
  });

  it('persists an automation initiator with roomote commit author and null acting user', async () => {
    const run = await launchFresh({
      initiator: {
        kind: 'automation',
        key: 'suggester',
        actor: { externalId: 'gh-123', displayName: 'PR Author' },
      },
      workflow: 'scan',
      surface: 'system',
      trigger: 'schedule',
      visibility: 'hidden',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('automation');
    expect(task!.initiatorAutomation).toBe('suggester');
    expect(task!.initiatorUserId).toBeNull();
    expect(task!.actorExternalId).toBe('gh-123');
    expect(task!.actorDisplayName).toBe('PR Author');
    expect(task!.visibility).toBe('hidden');
    expect(task!.commitAuthorKind).toBe('roomote');
    expect(task!.commitAuthorUserId).toBeNull();
    expect(task!.prAssigneeLogin).toBeNull();

    expect(run.actingUserId).toBeNull();
  });

  it('promotes matchedUserId to initiatorUserId while keeping actor context', async () => {
    const userId = await createUser();

    const run = await launchFresh({
      initiator: {
        kind: 'user',
        externalId: 'U999',
        displayName: 'Matched Human',
        matchedUserId: userId,
      },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, run.taskId),
    });

    expect(task!.initiatorKind).toBe('user');
    expect(task!.initiatorUserId).toBe(userId);
    expect(task!.actorExternalId).toBe('U999');
    expect(task!.actorDisplayName).toBe('Matched Human');
    expect(run.actingUserId).toBe(userId);
  });
});

describe('enqueueTask Session linkage', () => {
  beforeEach(async () => {
    await db
      .insert(deploymentSettings)
      .values({ id: 'default', metadata: { sessions_data: true } })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: { metadata: { sessions_data: true } },
      });
  });

  afterEach(async () => {
    await db
      .update(deploymentSettings)
      .set({ metadata: {} })
      .where(eq(deploymentSettings.id, 'default'));
  });

  it('creates exactly one Session link for a visible fresh task', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const links = await db
      .select()
      .from(sessionTasks)
      .where(eq(sessionTasks.taskId, run.taskId));
    expect(links).toHaveLength(1);
    expect(links[0]?.origin).toBe('direct_launch');
  });

  it('does not create Session links for hidden tasks', async () => {
    const userId = await createUser();
    const run = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'scan',
      surface: 'system',
      trigger: 'schedule',
      visibility: 'hidden',
    });

    await expect(
      db.select().from(sessionTasks).where(eq(sessionTasks.taskId, run.taskId)),
    ).resolves.toEqual([]);
  });
});

describe('enqueueTask snapshot resume', () => {
  it('atomically rejects concurrent resumes from the same source run', async () => {
    const userId = await createUser();
    const freshRun = await launchFresh({
      task: standardTaskInput({ computeProvider: 'modal' }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });
    const createResume = () =>
      enqueueTask(
        {
          task: {
            type: TaskPayloadKind.SnapshotResume,
            payload: {
              repo: 'acme/widgets',
              sourceSnapshotId: 'snap-concurrent',
              sourceRunId: freshRun.id,
            },
          } as SnapshotResumeTask,
          actingUserId: userId,
        },
        { enqueue: false },
      );

    const results = await Promise.allSettled([createResume(), createResume()]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(SnapshotResumeAlreadyExistsError);

    const resumeRuns = await db.query.taskRuns.findMany({
      where: and(
        eq(taskRuns.sourceRunId, freshRun.id),
        eq(taskRuns.kind, 'resume'),
      ),
    });
    expect(resumeRuns).toHaveLength(1);
  });

  it('attaches a resume run to the source task without re-attribution', async () => {
    const initiatorUserId = await createUser();
    const resumerUserId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput({ computeProvider: 'modal' }),
      initiator: { kind: 'user', userId: initiatorUserId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const taskBefore = await db.query.tasks.findFirst({
      where: eq(tasks.id, freshRun.taskId),
    });

    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-123',
        sourceRunId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      {
        task: resumeTask,
        actingUserId: resumerUserId,
      },
      { enqueue: false },
    );

    expect(resumeRun.taskId).toBe(freshRun.taskId);
    expect(resumeRun.kind).toBe('resume');
    expect(resumeRun.sourceRunId).toBe(freshRun.id);
    expect(resumeRun.payloadKind).toBe('snapshot_resume');
    expect(resumeRun.actingUserId).toBe(resumerUserId);
    expect(resumeRun.sourceSnapshotId).toBe('snap-123');
    expect(resumeRun.vendor).toBe(freshRun.vendor);

    // No task mutation, no attribution recomputation: the initiator stamp
    // and commit-author block are byte-identical to the fresh launch.
    const taskAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, freshRun.taskId),
    });

    expect(taskAfter).toEqual(taskBefore);
    expect(taskAfter!.initiatorUserId).toBe(initiatorUserId);

    const runsForTask = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, freshRun.taskId),
    });
    expect(runsForTask).toHaveLength(2);
  });

  it('inherits source-control stamps from the source run payload', async () => {
    const userId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'roomote/Test ADO/Test ADO',
          description: 'Do the thing',
          sourceControlProvider: 'ado',
          sourceControlHost: 'dev.azure.com',
          repositoryProviders: {
            'roomote/Test ADO/Test ADO': 'ado',
            'group/web': 'gitlab',
          },
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });

    // Resume entry points rebuild the payload from scratch and historically
    // dropped the provider stamp, which made workspace prep resolve the
    // repository against the GitHub default and fail.
    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'roomote/Test ADO/Test ADO',
        sourceSnapshotId: 'snap-ado-1',
        sourceRunId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );

    const resumePayload = resumeRun.payload as {
      sourceControlProvider?: string;
      sourceControlHost?: string;
      repositoryProviders?: Record<string, string>;
    };

    expect(resumePayload.sourceControlProvider).toBe('ado');
    expect(resumePayload.sourceControlHost).toBe('dev.azure.com');
    expect(resumePayload.repositoryProviders).toEqual({
      'roomote/Test ADO/Test ADO': 'ado',
      'group/web': 'gitlab',
    });
  });

  it('preserves Fast parent routing and communication isolation across resume', async () => {
    const userId = await createUser();
    const fastAgentSessionId = '11111111-1111-4111-8111-111111111111';
    const fastAgentParent = {
      sessionId: fastAgentSessionId,
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: '111.222',
        replyTarget: { channelId: 'C123', threadId: '111.222' },
      },
    };
    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Do the thing',
          communicationProvider: 'slack',
          communicationChannelId: 'C123',
          communicationThreadId: '111.222',
          communicationContextInherited: true,
          fastAgentSessionId,
          fastAgentParent,
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });
    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-fast-1',
        sourceRunId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );
    const resumePayload = resumeRun.payload as Record<string, unknown>;

    expect(resumePayload.communicationContextInherited).toBe(true);
    expect(resumePayload.fastAgentParent).toEqual(fastAgentParent);
    expect(resumePayload.fastAgentSessionId).toBe(fastAgentSessionId);
  });

  it('preserves a Discord Fast session across resume', async () => {
    const userId = await createUser();
    const fastAgentSessionId = '33333333-3333-4333-8333-333333333333';
    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Do the thing',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationThreadId: 'child-thread-1',
          fastAgentSessionId,
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'discord',
      trigger: 'message',
    });
    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-fast-discord-1',
        sourceRunId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );

    expect(
      (resumeRun.payload as Record<string, unknown>).fastAgentSessionId,
    ).toBe(fastAgentSessionId);
  });

  it('recovers Fast parent isolation from an older ancestor in a resume chain', async () => {
    const userId = await createUser();
    const fastAgentParent = {
      sessionId: '22222222-2222-4222-8222-222222222222',
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: '333.444',
        replyTarget: { channelId: 'C123', threadId: '333.444' },
      },
    };
    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Do the thing',
          communicationContextInherited: true,
          fastAgentParent,
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });
    const [legacyResume] = await db
      .insert(taskRuns)
      .values({
        taskId: freshRun.taskId,
        kind: 'resume',
        sourceRunId: freshRun.id,
        payloadKind: TaskPayloadKind.SnapshotResume,
        status: RunStatus.Completed,
        sourceSnapshotId: 'snap-fast-legacy',
        payload: {
          repo: 'acme/widgets',
          sourceSnapshotId: 'snap-fast-legacy',
          sourceRunId: freshRun.id,
        },
      })
      .returning();
    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-fast-latest',
        sourceRunId: legacyResume!.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );
    const resumePayload = resumeRun.payload as Record<string, unknown>;

    expect(resumePayload.communicationContextInherited).toBe(true);
    expect(resumePayload.fastAgentParent).toEqual(fastAgentParent);
  });

  it('inherits per-task model role overrides from the source run payload', async () => {
    const userId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput(),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    // Simulate a mid-task model change persisted by the task UI: the
    // overrides live on the run payload, not the launch spec.
    await db
      .update(taskRuns)
      .set({
        payload: {
          ...(freshRun.payload as Record<string, unknown>),
          reasoningEffort: 'xhigh',
          modelRoleOverrides: {
            planning: { model: 'openrouter/test/planner' },
            explore: { reasoningEffort: 'low' },
          },
        } as typeof freshRun.payload,
      })
      .where(eq(taskRuns.id, freshRun.id));

    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-models-1',
        sourceRunId: freshRun.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );

    const resumePayload = resumeRun.payload as {
      reasoningEffort?: string;
      modelRoleOverrides?: Record<string, unknown>;
    };

    expect(resumePayload.modelRoleOverrides).toEqual({
      planning: { model: 'openrouter/test/planner' },
      explore: { reasoningEffort: 'low' },
    });
    // The explicit coding level must survive the resume; without central
    // inheritance the enqueue would re-stamp the deployment default.
    expect(resumePayload.reasoningEffort).toBe('xhigh');
  });

  it('keeps concurrent role updates intact via the run-row lock', async () => {
    const userId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput(),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    // The UI's reset fan-out and the agent's update_models call can hit the
    // same run at once; each does a payload read-modify-write, so without
    // the FOR UPDATE lock one write silently overwrites the other.
    await Promise.all([
      applyTaskModelSelectionToRun({
        runId: freshRun.id,
        role: 'helper',
        model: null,
        reasoningEffort: 'high',
      }),
      applyTaskModelSelectionToRun({
        runId: freshRun.id,
        role: 'vision',
        model: null,
        reasoningEffort: 'low',
      }),
    ]);

    const run = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, freshRun.id),
      columns: { payload: true },
    });
    const payload = run?.payload as {
      modelRoleOverrides?: Record<string, unknown>;
    };

    expect(payload.modelRoleOverrides).toEqual({
      helper: { reasoningEffort: 'high' },
      vision: { reasoningEffort: 'low' },
    });
  });

  it('walks the resume chain for stamps when the source run predates inheritance', async () => {
    const userId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'roomote/Test ADO/Test ADO',
          description: 'Do the thing',
          sourceControlProvider: 'ado',
          sourceControlHost: 'dev.azure.com',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });

    // Simulate a resume row created before stamps were inherited: it points
    // at the stamped fresh run but its own rebuilt payload carries no stamps.
    const [legacyResume] = await db
      .insert(taskRuns)
      .values({
        taskId: freshRun.taskId,
        kind: 'resume',
        sourceRunId: freshRun.id,
        payloadKind: TaskPayloadKind.SnapshotResume,
        status: RunStatus.Completed,
        sourceSnapshotId: 'snap-legacy-1',
        payload: {
          repo: 'roomote/Test ADO/Test ADO',
          sourceSnapshotId: 'snap-legacy-1',
          sourceRunId: freshRun.id,
        },
      })
      .returning();

    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'roomote/Test ADO/Test ADO',
        sourceSnapshotId: 'snap-legacy-1',
        sourceRunId: legacyResume!.id,
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );

    const resumePayload = resumeRun.payload as {
      sourceControlProvider?: string;
      sourceControlHost?: string;
    };

    expect(resumePayload.sourceControlProvider).toBe('ado');
    expect(resumePayload.sourceControlHost).toBe('dev.azure.com');
  });

  it('keeps an explicit source-control provider on the resume payload', async () => {
    const userId = await createUser();

    const freshRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'acme/widgets',
          description: 'Do the thing',
          sourceControlProvider: 'ado',
          sourceControlHost: 'dev.azure.com',
          repositoryProviders: {
            'acme/widgets': 'ado',
            'group/web': 'gitlab',
          },
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const resumeTask: SnapshotResumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-explicit-1',
        sourceRunId: freshRun.id,
        sourceControlProvider: 'gitea',
      },
    } as SnapshotResumeTask;

    const resumeRun = await enqueueTask(
      { task: resumeTask, actingUserId: userId },
      { enqueue: false },
    );

    expect(
      (
        resumeRun.payload as {
          sourceControlProvider?: string;
          sourceControlHost?: string;
        }
      ).sourceControlProvider,
    ).toBe('gitea');
    expect(
      (resumeRun.payload as { sourceControlHost?: string }).sourceControlHost,
    ).toBeUndefined();
    expect(
      (
        resumeRun.payload as {
          repositoryProviders?: Record<string, string>;
        }
      ).repositoryProviders,
    ).toBeUndefined();
  });

  it('rejects a resume without a source run id', async () => {
    const resumeTask = {
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'acme/widgets',
        sourceSnapshotId: 'snap-void',
      },
    } as SnapshotResumeTask;

    await expect(
      enqueueTask({ task: resumeTask }, { enqueue: false }),
    ).rejects.toThrow('source run id');
  });
});

describe('enqueueTaskRelaunch failed start', () => {
  it('creates a new fresh run on the same task after a failed start', async () => {
    const userId = await createUser();

    const failedRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    await db
      .update(taskRuns)
      .set({
        status: RunStatus.Failed,
        error: 'Workspace has exceeded its spend limit',
        completedAt: new Date(),
      })
      .where(eq(taskRuns.id, failedRun.id));

    await db
      .update(tasks)
      .set({ state: 'failed' })
      .where(eq(tasks.id, failedRun.taskId));

    const relaunchRun = await enqueueTaskRelaunch(
      {
        sourceRunId: failedRun.id,
        actingUserId: userId,
      },
      { enqueue: false },
    );

    expect(relaunchRun.taskId).toBe(failedRun.taskId);
    expect(relaunchRun.id).not.toBe(failedRun.id);
    expect(relaunchRun.kind).toBe('fresh');
    expect(relaunchRun.sourceRunId).toBe(failedRun.id);
    expect(relaunchRun.payloadKind).toBe(TaskPayloadKind.StandardTask);
    expect(relaunchRun.status).toBe(RunStatus.Pending);
    expect(relaunchRun.actingUserId).toBe(userId);

    const taskAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, failedRun.taskId),
    });
    expect(taskAfter!.state).toBe('active');

    const runsForTask = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, failedRun.taskId),
    });
    expect(runsForTask).toHaveLength(2);
  });

  it('rejects relaunch when the source run is not failed', async () => {
    const userId = await createUser();

    const pendingRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    await expect(
      enqueueTaskRelaunch(
        {
          sourceRunId: pendingRun.id,
          actingUserId: userId,
        },
        { enqueue: false },
      ),
    ).rejects.toThrow('Only failed task starts can be retried');
  });

  it('drops Discord source-event ids so failed-start retry does not hit the unique index', async () => {
    const userId = await createUser();
    const sourceEventId = 'discord-source-event-retry-1';

    const failedRun = await enqueueTask(
      {
        initiator: { kind: 'user', userId },
        workflow: 'standard',
        surface: 'discord',
        trigger: 'message',
        task: standardTaskInput({
          payload: {
            repo: 'acme/widgets',
            description: 'Do the thing',
            communicationProvider: 'discord',
            communicationSourceEventId: sourceEventId,
            communicationChannelId: 'channel-1',
            communicationThreadId: 'thread-1',
          },
        }),
      } as FreshTaskLaunch,
      { enqueue: false, skipEarlyTitleGeneration: true },
    );
    createdTaskIds.push(failedRun.taskId);

    await db
      .update(taskRuns)
      .set({
        status: RunStatus.Failed,
        error: 'secretOrPrivateKey must be an asymmetric key when using ES256',
        completedAt: new Date(),
      })
      .where(eq(taskRuns.id, failedRun.id));

    await db
      .update(tasks)
      .set({ state: 'failed' })
      .where(eq(tasks.id, failedRun.taskId));

    const relaunchRun = await enqueueTaskRelaunch(
      {
        sourceRunId: failedRun.id,
        actingUserId: userId,
      },
      { enqueue: false },
    );

    expect(relaunchRun.taskId).toBe(failedRun.taskId);
    expect(relaunchRun.id).not.toBe(failedRun.id);
    expect(relaunchRun.payload).toMatchObject({
      communicationProvider: 'discord',
      communicationChannelId: 'channel-1',
      communicationThreadId: 'thread-1',
    });
    expect(relaunchRun.payload).not.toHaveProperty(
      'communicationSourceEventId',
    );
    expect(failedRun.payload).toMatchObject({
      communicationSourceEventId: sourceEventId,
    });
  });

  it('allows relaunch when only a provider kickoff message exists', async () => {
    const userId = await createUser();

    const failedRun = await launchFresh({
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'slack' as const,
      trigger: 'message',
    });

    await db
      .update(taskRuns)
      .set({
        status: RunStatus.Failed,
        error: 'Workspace has exceeded its spend limit',
        completedAt: new Date(),
      })
      .where(eq(taskRuns.id, failedRun.id));

    await db.insert(taskMessages).values({
      runId: failedRun.id,
      taskId: failedRun.taskId,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: [{ type: 'text', text: 'Looking into it in Full Stack.' }],
      metadata: { source: TASK_KICKOFF_MESSAGE_SOURCE },
      payload: {
        text: 'Looking into it in Full Stack.',
        source: TASK_KICKOFF_MESSAGE_SOURCE,
      },
    });

    const relaunchRun = await enqueueTaskRelaunch(
      {
        sourceRunId: failedRun.id,
        actingUserId: userId,
      },
      { enqueue: false },
    );

    expect(relaunchRun.taskId).toBe(failedRun.taskId);
    expect(relaunchRun.sourceRunId).toBe(failedRun.id);
  });
});

describe('enqueueTask PR linkage', () => {
  it('inserts the task_pull_requests row inside the create transaction', async () => {
    const prTask = {
      type: TaskPayloadKind.GithubPrReview,
      requestedWorkKindDecision: explicitWorkKind,
      payload: {
        repo: 'acme/widgets',
        prNumber: 77,
        prTitle: 'Add widgets',
        prUrl: 'https://github.com/acme/widgets/pull/77',
        headSha: 'a'.repeat(40),
      },
    } as Extract<TaskSpec, { type: 'github_pr_review' }>;

    const run = await launchFresh({
      task: prTask,
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: { externalId: '4242', displayName: 'octocat' },
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: {
        provider: 'github',
        repository: 'acme/widgets',
        prNumber: 77,
        prUrl: 'https://github.com/acme/widgets/pull/77',
        prTitle: 'Add widgets',
        prSha: 'a'.repeat(40),
        prBaseRef: 'main',
        prBaseSha: 'b'.repeat(40),
      },
    });

    const prRows = await db.query.taskPullRequests.findMany({
      where: eq(taskPullRequests.taskId, run.taskId),
    });

    expect(prRows).toHaveLength(1);
    expect(prRows[0]!.sourceControlProvider).toBe('github');
    expect(prRows[0]!.repository).toBe('acme/widgets');
    expect(prRows[0]!.prNumber).toBe(77);
    expect(prRows[0]!.prUrl).toBe('https://github.com/acme/widgets/pull/77');
    expect(prRows[0]!.prSha).toBe('a'.repeat(40));
    expect(prRows[0]!.prBaseRef).toBe('main');
    expect(prRows[0]!.prBaseSha).toBe('b'.repeat(40));
  });

  it('rejects pr_review launches without prLinkage', async () => {
    const prTask = {
      type: TaskPayloadKind.GithubPrReview,
      requestedWorkKindDecision: explicitWorkKind,
      payload: {
        repo: 'acme/widgets',
        prNumber: 78,
        prTitle: 'Add more widgets',
        prUrl: 'https://github.com/acme/widgets/pull/78',
        headSha: 'c'.repeat(40),
      },
    } as Extract<TaskSpec, { type: 'github_pr_review' }>;

    await expect(
      enqueueTask(
        {
          task: prTask,
          initiator: { kind: 'automation', key: 'review_code' },
          workflow: 'pr_review',
          surface: 'github',
          trigger: 'webhook',
        },
        { enqueue: false },
      ),
    ).rejects.toThrow('prLinkage');
  });

  it('adds later review runs to the existing PR task and updates its linkage', async () => {
    const prNumber = 79;
    const firstSha = 'd'.repeat(40);
    const secondSha = 'e'.repeat(40);
    const prUrl = `https://github.com/acme/widgets/pull/${prNumber}`;
    const makeTask = (headSha: string) =>
      ({
        type:
          headSha === firstSha
            ? TaskPayloadKind.GithubPrReview
            : TaskPayloadKind.GithubPrReviewSync,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: 'acme/widgets',
          prNumber,
          prTitle: 'Keep one review task',
          prUrl,
          headSha,
        },
      }) as FreshTaskLaunch['task'];
    const makeLinkage = (prSha: string) => ({
      provider: 'github' as const,
      repository: 'acme/widgets',
      prNumber,
      prUrl,
      prTitle: 'Keep one review task',
      prSha,
    });

    const firstRun = await enqueueTask(
      {
        task: makeTask(firstSha),
        initiator: { kind: 'automation', key: 'review_code' },
        workflow: 'pr_review',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: {
          ...makeLinkage(firstSha),
          githubReactionId: 101,
          githubCheckRunId: 202,
          githubReviewCommentId: 303,
        },
      },
      { enqueue: false, skipEarlyTitleGeneration: true },
    );
    createdTaskIds.push(firstRun.taskId);

    await db
      .update(taskRuns)
      .set({
        status: RunStatus.Completed,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(taskRuns.id, firstRun.id));
    await db
      .update(tasks)
      .set({ state: 'completed' })
      .where(eq(tasks.id, firstRun.taskId));

    const secondRun = await enqueueTask(
      {
        existingTaskId: firstRun.taskId,
        task: makeTask(secondSha),
        initiator: { kind: 'automation', key: 'review_code' },
        workflow: 'pr_review',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: makeLinkage(secondSha),
      },
      { enqueue: false, skipEarlyTitleGeneration: true },
    );

    const racingRun = await enqueueTask(
      {
        existingTaskId: firstRun.taskId,
        task: makeTask('f'.repeat(40)),
        initiator: { kind: 'automation', key: 'review_code' },
        workflow: 'pr_review',
        surface: 'github',
        trigger: 'webhook',
        prLinkage: makeLinkage('f'.repeat(40)),
      },
      { enqueue: false, skipEarlyTitleGeneration: true },
    );

    const persistedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, firstRun.taskId),
    });
    const persistedRuns = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, firstRun.taskId),
    });
    const persistedLinkage = await db.query.taskPullRequests.findFirst({
      where: eq(taskPullRequests.taskId, firstRun.taskId),
    });

    expect(secondRun.taskId).toBe(firstRun.taskId);
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(racingRun.id).toBe(secondRun.id);
    expect(secondRun.payloadKind).toBe(TaskPayloadKind.GithubPrReviewSync);
    expect(secondRun.payload).toMatchObject({ headSha: secondSha });
    expect(persistedTask?.state).toBe('active');
    expect(persistedRuns).toHaveLength(2);
    expect(persistedLinkage?.prSha).toBe(secondSha);
    expect(persistedLinkage?.githubReactionId).toBe(101);
    expect(persistedLinkage?.githubCheckRunId).toBe(202);
    expect(persistedLinkage?.githubReviewCommentId).toBe(303);
  });

  it('serializes concurrent first reviews into one durable PR task', async () => {
    const prNumber = 80;
    const prUrl = `https://github.com/acme/widgets/pull/${prNumber}`;
    const input = {
      task: {
        type: TaskPayloadKind.GithubPrReview,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: 'acme/widgets',
          prNumber,
          prTitle: 'Serialize review creation',
          prUrl,
          headSha: 'a'.repeat(40),
        },
      },
      initiator: { kind: 'automation', key: 'review_code' } as const,
      workflow: 'pr_review' as const,
      surface: 'github' as const,
      trigger: 'webhook' as const,
      prLinkage: {
        provider: 'github' as const,
        repository: 'acme/widgets',
        prNumber,
        prUrl,
        prSha: 'a'.repeat(40),
      },
    } satisfies FreshTaskLaunch;

    const [firstRun, racingRun] = await Promise.all([
      enqueueTask(input, { enqueue: false, skipEarlyTitleGeneration: true }),
      enqueueTask(input, { enqueue: false, skipEarlyTitleGeneration: true }),
    ]);
    createdTaskIds.push(firstRun.taskId);

    const persistedRuns = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, firstRun.taskId),
    });

    expect(racingRun.taskId).toBe(firstRun.taskId);
    expect(racingRun.id).toBe(firstRun.id);
    expect(persistedRuns).toHaveLength(1);
  });
});

describe('enqueue-failure cancel task state', () => {
  // A run canceled before it is queued must leave the owning task in a
  // terminal state. finishRun never runs for these runs, so
  // cancelTaskRunBeforeQueue is responsible for the tasks.state write.
  // Regression guard for tasks stranded in 'active' with a canceled run.
  it('marks the task canceled when the run is canceled before it is queued', async () => {
    const userId = await createUser();

    let capturedTaskId: string | undefined;

    await expect(
      enqueueTask(
        {
          task: standardTaskInput(),
          initiator: { kind: 'user', userId },
          workflow: 'standard',
          surface: 'web',
          trigger: 'manual',
        },
        {
          skipEarlyTitleGeneration: true,
          // Throwing before the queue push exercises the enqueue-failure
          // cancel path (cancelTaskRunBeforeQueue) after the task and its
          // first run have been persisted.
          beforeEnqueue: async (taskRun) => {
            capturedTaskId = taskRun.taskId;
            throw new Error('boom before enqueue');
          },
        },
      ),
    ).rejects.toThrow('boom before enqueue');

    expect(capturedTaskId).toBeDefined();
    createdTaskIds.push(capturedTaskId!);

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, capturedTaskId!),
    });
    const runs = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, capturedTaskId!),
    });

    expect(task!.state).toBe('canceled');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe(RunStatus.Canceled);
    expect(runs[0]!.canceledAt).not.toBeNull();
  });
});

describe('enqueueTask source-control provider stamping', () => {
  const createdEnvironmentIds: string[] = [];
  const createdRepositoryIds: string[] = [];

  afterAll(async () => {
    // Mappings cascade-delete with their environment/repository.
    if (createdEnvironmentIds.length > 0) {
      await db
        .delete(environments)
        .where(inArray(environments.id, createdEnvironmentIds));
    }
    if (createdRepositoryIds.length > 0) {
      await db
        .delete(repositories)
        .where(inArray(repositories.id, createdRepositoryIds));
    }
  });

  it('stamps gitlab on an environment-workspace launch for a gitlab-only deployment', async () => {
    const userId = await createUser();
    const repository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/project',
      isActive: true,
    });
    createdRepositoryIds.push(repository.id);

    const environment = await environmentFactory.create({
      createdByUserId: userId,
      config: {
        name: 'GitLab environment',
        repositories: [{ repository: 'group/project' }],
      },
    });
    createdEnvironmentIds.push(environment.id);

    await db.insert(environmentRepositoryMappings).values({
      environmentId: environment.id,
      repositoryId: repository.id,
    });

    const run = await launchFresh({
      task: standardTaskInput({
        payload: {
          // environmentId makes this an environment workspace regardless of
          // repo, so the provider must resolve via the environment-repository
          // mapping (this repo is intentionally not in the repositories table).
          repo: 'unmapped/repo',
          environmentId: environment.id,
          description: 'Work in the gitlab environment',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    const persistedRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
    });

    expect(
      (persistedRun!.payload as { sourceControlProvider?: string })
        .sourceControlProvider,
    ).toBe('gitlab');
    expect(
      (persistedRun!.payload as { repositoryProviders?: unknown })
        .repositoryProviders,
    ).toBeUndefined();
  });

  it('stamps a provider map and the first repository provider for a mixed environment', async () => {
    const userId = await createUser();
    const primaryRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/mixed-api',
      isActive: true,
    });
    const secondaryRepository = await repositoryFactory.create({
      sourceControlProvider: 'ado',
      linkedByUserId: userId,
      fullName: 'acme/Platform/mixed-web',
      isActive: true,
    });
    createdRepositoryIds.push(primaryRepository.id, secondaryRepository.id);

    const environment = await environmentFactory.create({
      createdByUserId: userId,
      config: {
        name: 'Mixed environment',
        repositories: [
          { repository: 'group/mixed-api' },
          { repository: 'acme/Platform/mixed-web' },
        ],
      },
    });
    createdEnvironmentIds.push(environment.id);

    await db.insert(environmentRepositoryMappings).values([
      {
        environmentId: environment.id,
        repositoryId: primaryRepository.id,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        environmentId: environment.id,
        repositoryId: secondaryRepository.id,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ]);

    const run = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'group/mixed-api',
          environmentId: environment.id,
          description: 'Work in the mixed environment',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    expect(run.payload).toMatchObject({
      sourceControlProvider: 'gitlab',
      repositoryProviders: {
        'group/mixed-api': 'gitlab',
        'acme/Platform/mixed-web': 'ado',
      },
    });
    expect(run.payload.sourceControlHost).toBeUndefined();
  });

  it('stamps mixed selected repositories in selection order', async () => {
    const userId = await createUser();
    const gitLabRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/selected-web',
      isActive: true,
    });
    const adoRepository = await repositoryFactory.create({
      sourceControlProvider: 'ado',
      linkedByUserId: userId,
      fullName: 'acme/Platform/selected-api',
      isActive: true,
    });
    createdRepositoryIds.push(gitLabRepository.id, adoRepository.id);

    const run = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: [
            'group/selected-web',
            'acme/Platform/selected-api',
          ],
          description: 'Work across selected providers',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    expect(run.payload).toMatchObject({
      sourceControlProvider: 'gitlab',
      repositoryProviders: {
        'group/selected-web': 'gitlab',
        'acme/Platform/selected-api': 'ado',
      },
    });
  });

  it('re-stamps a PR launch after auto-resolving a mixed environment', async () => {
    const userId = await createUser();
    const primaryRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/pr-context',
      isActive: true,
    });
    const pullRequestRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitea',
      linkedByUserId: userId,
      fullName: 'octo/pr-target',
      isActive: true,
    });
    createdRepositoryIds.push(primaryRepository.id, pullRequestRepository.id);

    const environment = await environmentFactory.create({
      createdByUserId: userId,
      config: {
        name: 'PR mixed environment',
        repositories: [
          { repository: 'group/pr-context' },
          { repository: 'octo/pr-target' },
        ],
      },
    });
    createdEnvironmentIds.push(environment.id);
    await db.insert(environmentRepositoryMappings).values([
      {
        environmentId: environment.id,
        repositoryId: primaryRepository.id,
      },
      {
        environmentId: environment.id,
        repositoryId: pullRequestRepository.id,
      },
    ]);

    const run = await launchFresh({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: 'octo/pr-target',
          prNumber: 1082,
          prTitle: 'Support mixed environments',
          prUrl: 'https://github.com/octo/pr-target/pull/1082',
          headSha: 'a'.repeat(40),
          sourceControlProvider: 'gitea',
          sourceControlHost: 'gitea.example.com',
        },
      } as Extract<TaskSpec, { type: 'github_pr_review' }>,
      initiator: { kind: 'automation', key: 'review_code' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: {
        provider: 'gitea',
        repository: 'octo/pr-target',
        prNumber: 1082,
        prUrl: 'https://github.com/octo/pr-target/pull/1082',
        prTitle: 'Support mixed environments',
        prSha: 'a'.repeat(40),
      },
    });

    expect(run.payload).toMatchObject({
      environmentId: environment.id,
      sourceControlProvider: 'gitlab',
      repositoryProviders: {
        'group/pr-context': 'gitlab',
        'octo/pr-target': 'gitea',
      },
    });
    expect(run.payload.sourceControlHost).toBeUndefined();
  });

  it('recomputes mixed-provider stamps for a failed-start relaunch', async () => {
    const userId = await createUser();
    const primaryRepository = await repositoryFactory.create({
      sourceControlProvider: 'gitlab',
      linkedByUserId: userId,
      fullName: 'group/relaunch-api',
      isActive: true,
    });
    const secondaryRepository = await repositoryFactory.create({
      sourceControlProvider: 'ado',
      linkedByUserId: userId,
      fullName: 'acme/Platform/relaunch-web',
      isActive: true,
    });
    createdRepositoryIds.push(primaryRepository.id, secondaryRepository.id);

    const environment = await environmentFactory.create({
      createdByUserId: userId,
      config: {
        name: 'Relaunch environment',
        repositories: [
          { repository: 'group/relaunch-api' },
          { repository: 'acme/Platform/relaunch-web' },
        ],
      },
    });
    createdEnvironmentIds.push(environment.id);
    await db.insert(environmentRepositoryMappings).values([
      {
        environmentId: environment.id,
        repositoryId: primaryRepository.id,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        environmentId: environment.id,
        repositoryId: secondaryRepository.id,
        createdAt: new Date('2026-01-02T00:00:01.000Z'),
      },
    ]);

    const failedRun = await launchFresh({
      task: standardTaskInput({
        payload: {
          repo: 'group/relaunch-api',
          environmentId: environment.id,
          description: 'Work in the mixed environment',
        },
      }),
      initiator: { kind: 'user', userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });
    const legacyPayload = { ...failedRun.payload };
    delete legacyPayload.sourceControlProvider;
    delete legacyPayload.repositoryProviders;
    await db
      .update(taskRuns)
      .set({
        payload: legacyPayload,
        status: RunStatus.Failed,
        error: 'Failed to create source control token',
        completedAt: new Date(),
      })
      .where(eq(taskRuns.id, failedRun.id));
    await db
      .update(tasks)
      .set({ state: 'failed' })
      .where(eq(tasks.id, failedRun.taskId));

    const relaunchRun = await enqueueTaskRelaunch(
      { sourceRunId: failedRun.id, actingUserId: userId },
      { enqueue: false },
    );

    expect(relaunchRun.payload).toMatchObject({
      sourceControlProvider: 'gitlab',
      repositoryProviders: {
        'group/relaunch-api': 'gitlab',
        'acme/Platform/relaunch-web': 'ado',
      },
    });
  });
});

describe('pr_review queue scope dedup', () => {
  let previousQueue: TaskRunQueue | null;
  let queueRedis: InstanceType<typeof Redis>;

  beforeEach(() => {
    previousQueue = TaskRunQueue.queue;
    queueRedis = new Redis();
    TaskRunQueue.queue = new TaskRunQueue({ redis: queueRedis, timeout: 1 });
  });

  afterEach(async () => {
    TaskRunQueue.queue = previousQueue;
    await queueRedis.flushall();
    queueRedis.disconnect();
  });

  const prLinkage = {
    provider: 'github' as const,
    repository: 'acme/widgets',
    prNumber: 42,
    prUrl: 'https://github.com/acme/widgets/pull/42',
  };

  it('computes a stable repo:prNumber scope for pr_review launches', () => {
    const first = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReview,
      prLinkage,
    });
    const second = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      prLinkage,
    });

    expect(first).toBe('acme/widgets:42');
    expect(second).toBe('acme/widgets:42');
  });

  it('debounces GitHub commit re-reviews without changing other launches', () => {
    const now = 1_000_000;

    expect(
      resolvePrReviewQueuePolicy({
        payloadKind: TaskPayloadKind.GithubPrReviewSync,
        sourceControlProvider: 'github',
        now,
      }),
    ).toEqual({
      availableAt: now + PR_REVIEW_SYNC_DEBOUNCE_MS,
      preserveExisting: true,
    });
    expect(
      resolvePrReviewQueuePolicy({
        payloadKind: TaskPayloadKind.GithubPrReview,
        sourceControlProvider: 'github',
        now,
      }),
    ).toEqual({});
    expect(
      resolvePrReviewQueuePolicy({
        payloadKind: TaskPayloadKind.GithubPrReviewSync,
        sourceControlProvider: 'gitlab',
        now,
      }),
    ).toEqual({});
  });

  it('gives non-pr-review launches unique scopes', () => {
    const one = resolveQueueScope({
      workflow: 'standard',
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const two = resolveQueueScope({
      workflow: 'standard',
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const conflict = resolveQueueScope({
      workflow: 'pr_conflict_resolve',
      payloadKind: TaskPayloadKind.GithubPrConflictResolve,
      prLinkage,
    });

    expect(one).not.toBe(two);
    expect(conflict).not.toBe('acme/widgets:42');
  });

  it('supersedes an older queued entry with the same pr_review scope', async () => {
    const redis = new Redis();
    const queue = new TaskRunQueue({ redis, timeout: 1 });
    const scope = resolveQueueScope({
      workflow: 'pr_review',
      payloadKind: TaskPayloadKind.GithubPrReview,
      prLinkage,
    });

    await queue.enqueue({ id: 900001, scope });
    await queue.enqueue({ id: 900002, scope });

    const dequeued = await queue.dequeue(false);
    expect(dequeued?.id).toBe(900002);

    const empty = await queue.dequeue(false);
    expect(empty).toBeNull();

    await redis.flushall();
  });

  it('keeps one queued run and task for the same GitHub PR', async () => {
    const uniquePrNumber = 424_242;
    const scope = `acme/queue-atomic:${uniquePrNumber}`;
    const linkage = {
      provider: 'github' as const,
      repository: 'acme/queue-atomic',
      prNumber: uniquePrNumber,
      prUrl: `https://github.com/acme/queue-atomic/pull/${uniquePrNumber}`,
    };
    const makeInput = (headSha: string): FreshTaskLaunch => ({
      task: {
        type: TaskPayloadKind.GithubPrReview,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: linkage.repository,
          prNumber: linkage.prNumber,
          prTitle: 'Atomic queue review',
          prUrl: linkage.prUrl,
          headSha,
        },
      },
      initiator: { kind: 'automation', key: 'review_code' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: linkage,
    });

    const older = await enqueueTask(makeInput('a'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    createdTaskIds.push(older.taskId);

    const newer = await enqueueTask(makeInput('b'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    expect(newer.id).toBe(older.id);
    expect(newer.taskId).toBe(older.taskId);

    const persistedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.id, [older.id, newer.id]),
    });
    const persistedOlder = persistedRuns.find((run) => run.id === older.id);

    expect(persistedOlder?.queueScope).toBe(scope);
    expect(persistedOlder?.status).toBe(RunStatus.Pending);
    expect(persistedRuns).toHaveLength(1);

    const queued = await TaskRunQueue.getInstance().dequeue(false);
    expect(queued).toEqual({ id: newer.id, scope });
    await TaskRunQueue.getInstance().releaseLock(scope, newer.id);
  });

  it('returns the first queued GitHub re-review for a racing launch', async () => {
    const uniquePrNumber = 424_243;
    const linkage = {
      provider: 'github' as const,
      repository: 'acme/queue-first-wins',
      prNumber: uniquePrNumber,
      prUrl: `https://github.com/acme/queue-first-wins/pull/${uniquePrNumber}`,
    };
    const makeInput = (headSha: string): FreshTaskLaunch => ({
      task: {
        type: TaskPayloadKind.GithubPrReviewSync,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: linkage.repository,
          prNumber: linkage.prNumber,
          prTitle: 'First-wins re-review',
          prUrl: linkage.prUrl,
          headSha,
        },
      },
      initiator: { kind: 'automation', key: 'review_code' },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: linkage,
    });

    const existing = await enqueueTask(makeInput('a'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    const incoming = await enqueueTask(makeInput('b'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    createdTaskIds.push(existing.taskId);

    const persistedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.id, [existing.id, incoming.id]),
    });

    expect(persistedRuns.find((run) => run.id === existing.id)?.status).toBe(
      RunStatus.Pending,
    );
    expect(incoming.id).toBe(existing.id);
    expect(incoming.taskId).toBe(existing.taskId);
    expect(persistedRuns).toHaveLength(1);
  });

  it('keeps non-GitHub re-reviews immediate and replaces a stale queued head', async () => {
    const uniquePrNumber = 424_244;
    const linkage = {
      provider: 'gitlab' as const,
      repository: 'acme/gitlab-last-wins',
      prNumber: uniquePrNumber,
      prUrl: `https://gitlab.example.com/acme/gitlab-last-wins/-/merge_requests/${uniquePrNumber}`,
    };
    const makeInput = (headSha: string): FreshTaskLaunch => ({
      task: {
        type: TaskPayloadKind.GithubPrReviewSync,
        requestedWorkKindDecision: explicitWorkKind,
        payload: {
          repo: linkage.repository,
          sourceControlProvider: 'gitlab',
          prNumber: linkage.prNumber,
          prTitle: 'GitLab last-wins re-review',
          prUrl: linkage.prUrl,
          headSha,
        },
      },
      initiator: { kind: 'automation', key: 'review_code' },
      workflow: 'pr_review',
      surface: 'gitlab',
      trigger: 'webhook',
      prLinkage: linkage,
    });

    const stale = await enqueueTask(makeInput('a'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    const current = await enqueueTask(makeInput('b'.repeat(40)), {
      skipEarlyTitleGeneration: true,
    });
    createdTaskIds.push(stale.taskId, current.taskId);

    const persistedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.id, [stale.id, current.id]),
    });

    expect(persistedRuns.find((run) => run.id === stale.id)?.status).toBe(
      RunStatus.Canceled,
    );
    expect(persistedRuns.find((run) => run.id === current.id)?.status).toBe(
      RunStatus.Pending,
    );

    const queued = await TaskRunQueue.getInstance().dequeue(false);
    expect(queued).toEqual({
      id: current.id,
      scope: `${linkage.repository}:${linkage.prNumber}`,
    });
    await TaskRunQueue.getInstance().releaseLock(queued!.scope, current.id);
  });
});
