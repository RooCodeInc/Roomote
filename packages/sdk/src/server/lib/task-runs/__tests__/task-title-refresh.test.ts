import {
  db,
  eq,
  taskFactory,
  taskMessages,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES, TaskPayloadKind } from '@roomote/types';
import { LLM_TITLE_LOCKED_CHECKPOINT } from '@roomote/cloud-agents/server';

import {
  recordTaskMessageEnvelope,
  refreshTaskTitleOnCompletion,
} from '../record-task-message-envelope';

const {
  mockGenerateLlmTaskTitle,
  mockRefreshTaskSessionTitle,
  mockSyncTaskThreadTitle,
} = vi.hoisted(() => ({
  mockGenerateLlmTaskTitle: vi.fn(),
  mockRefreshTaskSessionTitle: vi.fn(),
  mockSyncTaskThreadTitle: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actual,
    generateLlmTaskTitle: mockGenerateLlmTaskTitle,
    refreshTaskSessionTitle: mockRefreshTaskSessionTitle,
  };
});

vi.mock('../../task-thread-title-sync', () => ({
  syncTaskCommunicationThreadTitleBestEffort: mockSyncTaskThreadTitle,
}));

async function seedTaskWithPrompt({
  taskId,
  title,
  llmTitleCheckpoint,
  titleEditedByUserAt = null,
}: {
  taskId: string;
  title: string;
  llmTitleCheckpoint: number;
  titleEditedByUserAt?: Date | null;
}) {
  await taskFactory.create({
    id: taskId,
    modelProvider: 'roomote',
    model: 'test-model',
    title,
    llmTitleCheckpoint,
    titleEditedByUserAt,
    workflow: 'pr_review',
    surface: 'github',
    trigger: 'webhook',
  });

  const [job] = await db
    .insert(taskRuns)
    .values({
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      payload: { repo: 'owner/repo' },
      taskId,
    })
    .returning({ id: taskRuns.id });

  if (!job) {
    throw new Error('Failed to seed task run');
  }

  await db.insert(taskMessages).values({
    runId: job.id,
    taskId,
    ts: Date.now(),
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    protocol: 'roomote_runtime',
    contentBlocks: [
      { type: 'text', text: '$review-code <request>Review this PR</request>' },
    ],
    payload: {},
  });

  return job.id;
}

describe('task title refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateLlmTaskTitle.mockReset();
    mockGenerateLlmTaskTitle.mockResolvedValue('Generated summary title');
    mockRefreshTaskSessionTitle.mockReset();
    mockRefreshTaskSessionTitle.mockResolvedValue(undefined);
    mockSyncTaskThreadTitle.mockResolvedValue(undefined);
  });

  it('regenerates the title from the transcript when the job completes', async () => {
    const runId = await seedTaskWithPrompt({
      taskId: 'task-title-final',
      title: 'Early truncated title',
      llmTitleCheckpoint: 1,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-final',
      runId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-final'),
      columns: { title: true, llmTitleCheckpoint: true },
    });

    expect(task?.title).toBe('Generated summary title');
    expect(task?.llmTitleCheckpoint).toBe(LLM_TITLE_LOCKED_CHECKPOINT);
    expect(mockSyncTaskThreadTitle).toHaveBeenCalledWith({
      taskId: 'task-title-final',
    });
    expect(mockRefreshTaskSessionTitle).toHaveBeenCalledWith({
      taskId: 'task-title-final',
      userId: undefined,
      mode: 'final',
    });
  });

  it('never rewrites a locked deterministic title', async () => {
    const runId = await seedTaskWithPrompt({
      taskId: 'task-title-locked',
      title: 'Review PR #193: Membership-based sign-in',
      llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-locked',
      runId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-locked'),
      columns: { title: true },
    });

    expect(task?.title).toBe('Review PR #193: Membership-based sign-in');
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('never rewrites a user-edited title', async () => {
    const runId = await seedTaskWithPrompt({
      taskId: 'task-title-user-edited',
      title: 'My custom title',
      llmTitleCheckpoint: 1,
      titleEditedByUserAt: new Date(),
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-user-edited',
      runId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-user-edited'),
      columns: { title: true },
    });

    expect(task?.title).toBe('My custom title');
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('runs the final refresh only once', async () => {
    const runId = await seedTaskWithPrompt({
      taskId: 'task-title-once',
      title: 'Early truncated title',
      llmTitleCheckpoint: 1,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-once',
      runId,
    });
    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-once',
      runId,
    });

    expect(mockGenerateLlmTaskTitle).toHaveBeenCalledTimes(1);
  });

  it('skips the final refresh once the task reached the 20-message checkpoint', async () => {
    const runId = await seedTaskWithPrompt({
      taskId: 'task-title-checkpoint-20',
      title: 'Checkpoint 20 title',
      llmTitleCheckpoint: 20,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-checkpoint-20',
      runId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-checkpoint-20'),
      columns: { title: true, llmTitleCheckpoint: true },
    });

    expect(task?.title).toBe('Checkpoint 20 title');
    expect(task?.llmTitleCheckpoint).toBe(20);
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('re-syncs the provider thread on the opening user prompt when checkpoint 1 is already locked', async () => {
    const taskId = 'task-title-opening-resync';
    await taskFactory.create({
      id: taskId,
      modelProvider: 'roomote',
      model: 'test-model',
      title: 'Early title already locked',
      llmTitleCheckpoint: 1,
      workflow: 'standard',
      surface: 'discord',
      trigger: 'message',
    });

    const [job] = await db
      .insert(taskRuns)
      .values({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          communicationProvider: 'discord',
          discordTaskThread: true,
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
        taskId,
      })
      .returning({ id: taskRuns.id });

    if (!job) {
      throw new Error('Failed to seed task run');
    }

    await recordTaskMessageEnvelope({
      runId: job.id,
      taskId,
      envelope: {
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        protocol: 'roomote_runtime',
        contentBlocks: [{ type: 'text', text: 'Fix the flaky login tests' }],
        metadata: null,
        payload: {},
      },
    });

    await vi.waitFor(() => {
      expect(mockSyncTaskThreadTitle).toHaveBeenCalledWith({ taskId });
      expect(mockRefreshTaskSessionTitle).toHaveBeenCalledWith({
        taskId,
        userId: undefined,
        mode: 'checkpoint',
      });
    });
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('still syncs provider threads when opening-prompt generation falls back', async () => {
    const taskId = 'task-title-fallback-resync';
    mockGenerateLlmTaskTitle.mockResolvedValueOnce('Untitled task');

    await taskFactory.create({
      id: taskId,
      modelProvider: 'roomote',
      model: 'test-model',
      title: 'Early title waiting for rename',
      llmTitleCheckpoint: 0,
      workflow: 'standard',
      surface: 'discord',
      trigger: 'message',
    });

    const [job] = await db
      .insert(taskRuns)
      .values({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          communicationProvider: 'discord',
          discordTaskThread: true,
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
        taskId,
      })
      .returning({ id: taskRuns.id });

    if (!job) {
      throw new Error('Failed to seed task run');
    }

    await recordTaskMessageEnvelope({
      runId: job.id,
      taskId,
      envelope: {
        ts: Date.now(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        protocol: 'roomote_runtime',
        contentBlocks: [{ type: 'text', text: 'Fix the flaky login tests' }],
        metadata: null,
        payload: {},
      },
    });

    await vi.waitFor(async () => {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { title: true, llmTitleCheckpoint: true },
      });
      expect(task).toEqual({
        title: 'Early title waiting for rename',
        llmTitleCheckpoint: 1,
      });
      expect(mockSyncTaskThreadTitle).toHaveBeenCalledWith({ taskId });
    });
  });
});
