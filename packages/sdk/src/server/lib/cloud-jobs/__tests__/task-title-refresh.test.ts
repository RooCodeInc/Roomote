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

import { refreshTaskTitleOnCompletion } from '../record-task-message-envelope';

const { mockGenerateLlmTaskTitle } = vi.hoisted(() => ({
  mockGenerateLlmTaskTitle: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/cloud-agents/server')>();

  return {
    ...actual,
    generateLlmTaskTitle: mockGenerateLlmTaskTitle,
  };
});

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
    provider: 'roomote',
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
    throw new Error('Failed to seed cloud job');
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
    mockGenerateLlmTaskTitle.mockReset();
    mockGenerateLlmTaskTitle.mockResolvedValue('Generated summary title');
  });

  it('regenerates the title from the transcript when the job completes', async () => {
    const cloudJobId = await seedTaskWithPrompt({
      taskId: 'task-title-final',
      title: 'Early truncated title',
      llmTitleCheckpoint: 1,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-final',
      cloudJobId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-final'),
      columns: { title: true, llmTitleCheckpoint: true },
    });

    expect(task?.title).toBe('Generated summary title');
    expect(task?.llmTitleCheckpoint).toBe(LLM_TITLE_LOCKED_CHECKPOINT);
  });

  it('never rewrites a locked deterministic title', async () => {
    const cloudJobId = await seedTaskWithPrompt({
      taskId: 'task-title-locked',
      title: 'Review PR #193: Membership-based sign-in',
      llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-locked',
      cloudJobId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-locked'),
      columns: { title: true },
    });

    expect(task?.title).toBe('Review PR #193: Membership-based sign-in');
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('never rewrites a user-edited title', async () => {
    const cloudJobId = await seedTaskWithPrompt({
      taskId: 'task-title-user-edited',
      title: 'My custom title',
      llmTitleCheckpoint: 1,
      titleEditedByUserAt: new Date(),
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-user-edited',
      cloudJobId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-user-edited'),
      columns: { title: true },
    });

    expect(task?.title).toBe('My custom title');
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('runs the final refresh only once', async () => {
    const cloudJobId = await seedTaskWithPrompt({
      taskId: 'task-title-once',
      title: 'Early truncated title',
      llmTitleCheckpoint: 1,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-once',
      cloudJobId,
    });
    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-once',
      cloudJobId,
    });

    expect(mockGenerateLlmTaskTitle).toHaveBeenCalledTimes(1);
  });

  it('skips the final refresh once the task reached the 20-message checkpoint', async () => {
    const cloudJobId = await seedTaskWithPrompt({
      taskId: 'task-title-checkpoint-20',
      title: 'Checkpoint 20 title',
      llmTitleCheckpoint: 20,
    });

    await refreshTaskTitleOnCompletion({
      taskId: 'task-title-checkpoint-20',
      cloudJobId,
    });

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, 'task-title-checkpoint-20'),
      columns: { title: true, llmTitleCheckpoint: true },
    });

    expect(task?.title).toBe('Checkpoint 20 title');
    expect(task?.llmTitleCheckpoint).toBe(20);
    expect(mockGenerateLlmTaskTitle).not.toHaveBeenCalled();
  });
});
