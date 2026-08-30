import {
  db,
  ensureSessionForFastConversation,
  ensureSessionForTask,
  fastAgentConversations,
  fastAgentMessages,
  eq,
  sessions,
  taskFactory,
  taskMessages,
  taskRuns,
  tasks,
  userFactory,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES, TaskPayloadKind } from '@roomote/types';

import {
  refreshFastAgentSessionTitle,
  refreshTaskSessionTitle,
} from '../fast-agent-title';
import { LLM_TITLE_LOCKED_CHECKPOINT } from '../../llm-task-title';

const generateLlmTaskTitle = vi.hoisted(() => vi.fn());

vi.mock('../../llm-task-title', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm-task-title')>()),
  generateLlmTaskTitle,
}));

async function createConversation(userId: string, conversationId: string) {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: userId,
      conversationId,
    })
    .returning();

  await ensureSessionForFastConversation(db, conversation!.id);

  return conversation!;
}

async function createTaskSession() {
  const task = await taskFactory.create({ title: 'New session' });
  const session = await ensureSessionForTask(db, { taskId: task.id });
  if (!session) throw new Error('Failed to create task Session');
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: 'owner/repo' },
    })
    .returning({ id: taskRuns.id });
  await db.insert(taskMessages).values({
    taskId: task.id,
    runId: run!.id,
    ts: 1,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    protocol: 'roomote_runtime',
    contentBlocks: [
      { type: 'text', text: 'Investigate session title refresh' },
    ],
    payload: {},
  });
  return { task, session };
}

async function insertMessage({
  conversationId,
  eventId,
  role,
  text,
  ts,
  eventType,
  metadata = { visibleInTranscript: true },
}: {
  conversationId: string;
  eventId: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  eventType: `roomote_runtime.${string}`;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(fastAgentMessages).values({
    conversationId,
    eventId,
    turnId: 'turn-1',
    turnSeq: ts,
    ts,
    eventType,
    role,
    contentBlocks: [{ type: 'text', text }],
    metadata,
    payload: {},
    source: 'web',
  });
}

describe('refreshFastAgentSessionTitle', () => {
  beforeEach(() => {
    generateLlmTaskTitle.mockReset();
  });

  it('titles a session at the first user-message checkpoint', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation(user.id, 'title-first');
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:user',
      role: 'user',
      text: 'How do I rotate the API keys?',
      ts: 1,
      eventType: 'roomote_runtime.user_prompt',
    });
    generateLlmTaskTitle.mockResolvedValue('Rotate the API keys');

    await refreshFastAgentSessionTitle({
      sessionId: conversation.id,
      userId: user.id,
    });

    const updated = await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, conversation.id),
    });
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.fastConversationId, conversation.id),
    });
    expect(updated?.title).toBe('Rotate the API keys');
    expect(updated?.llmTitleCheckpoint).toBe(1);
    expect(session?.title).toBe('Rotate the API keys');
    expect(session?.llmTitleCheckpoint).toBe(1);
    expect(generateLlmTaskTitle).toHaveBeenCalledWith({
      userId: user.id,
      taskId: null,
      messages: [{ role: 'user', text: 'How do I rotate the API keys?' }],
    });
  });

  it('does not regenerate before the next checkpoint and skips hidden prompts', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation(user.id, 'title-gate');
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:user',
      role: 'user',
      text: 'First question',
      ts: 1,
      eventType: 'roomote_runtime.user_prompt',
    });
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'turn-2:user',
      role: 'user',
      text: '<platform_event>{}</platform_event>',
      ts: 2,
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: false },
    });
    await db
      .update(fastAgentConversations)
      .set({ title: 'Existing title', llmTitleCheckpoint: 1 })
      .where(eq(fastAgentConversations.id, conversation.id));

    await refreshFastAgentSessionTitle({
      sessionId: conversation.id,
      userId: user.id,
    });

    expect(generateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('never overwrites a user-edited title', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation(user.id, 'title-edited');
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:user',
      role: 'user',
      text: 'A question',
      ts: 1,
      eventType: 'roomote_runtime.user_prompt',
    });
    await db
      .update(fastAgentConversations)
      .set({ title: 'My name', titleEditedByUserAt: new Date() })
      .where(eq(fastAgentConversations.id, conversation.id));

    await refreshFastAgentSessionTitle({
      sessionId: conversation.id,
      userId: user.id,
    });

    expect(generateLlmTaskTitle).not.toHaveBeenCalled();
    const updated = await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, conversation.id),
    });
    expect(updated?.title).toBe('My name');
  });

  it('never overwrites a manually renamed unified Fast Session', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation(
      user.id,
      'title-unified-edited',
    );
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'turn-1:user',
      role: 'user',
      text: 'A question',
      ts: 1,
      eventType: 'roomote_runtime.user_prompt',
    });
    await db
      .update(sessions)
      .set({
        title: 'My unified Session title',
        titleEditedByUserAt: new Date(),
      })
      .where(eq(sessions.fastConversationId, conversation.id));
    generateLlmTaskTitle.mockResolvedValue('Generated Fast title');

    await refreshFastAgentSessionTitle({
      sessionId: conversation.id,
      userId: user.id,
    });

    const session = await db.query.sessions.findFirst({
      where: eq(sessions.fastConversationId, conversation.id),
    });
    expect(session?.title).toBe('My unified Session title');
    expect(session?.llmTitleCheckpoint).toBe(0);
  });

  it('generates a task-only Session title independently from its task', async () => {
    const { task, session } = await createTaskSession();
    generateLlmTaskTitle.mockResolvedValue('Independent Session title');

    await refreshTaskSessionTitle({
      taskId: task.id,
      mode: 'checkpoint',
    });

    const updatedSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    const unchangedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updatedSession?.title).toBe('Independent Session title');
    expect(updatedSession?.llmTitleCheckpoint).toBe(1);
    expect(unchangedTask?.title).toBe('New session');
  });

  it('does not overwrite a manually renamed task-only Session', async () => {
    const { task, session } = await createTaskSession();
    await db
      .update(sessions)
      .set({
        title: 'Manual Session title',
        titleEditedByUserAt: new Date(),
      })
      .where(eq(sessions.id, session.id));

    await refreshTaskSessionTitle({
      taskId: task.id,
      mode: 'checkpoint',
    });

    expect(generateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('preserves a Session rename that lands while title generation is running', async () => {
    const { task, session } = await createTaskSession();
    generateLlmTaskTitle.mockImplementationOnce(async () => {
      await db
        .update(sessions)
        .set({
          title: 'Concurrent manual title',
          titleEditedByUserAt: new Date(),
        })
        .where(eq(sessions.id, session.id));
      return 'Stale generated title';
    });

    await refreshTaskSessionTitle({
      taskId: task.id,
      mode: 'checkpoint',
    });

    const unchanged = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(unchanged?.title).toBe('Concurrent manual title');
    expect(unchanged?.llmTitleCheckpoint).toBe(0);
  });

  it('locks a task-only Session title after completion refresh', async () => {
    const { task, session } = await createTaskSession();
    generateLlmTaskTitle.mockResolvedValueOnce('Completed Session title');

    await refreshTaskSessionTitle({ taskId: task.id, mode: 'final' });

    const updated = await db.query.sessions.findFirst({
      where: eq(sessions.id, session.id),
    });
    expect(updated?.title).toBe('Completed Session title');
    expect(updated?.llmTitleCheckpoint).toBe(LLM_TITLE_LOCKED_CHECKPOINT);

    generateLlmTaskTitle.mockClear();
    await refreshTaskSessionTitle({ taskId: task.id, mode: 'checkpoint' });
    expect(generateLlmTaskTitle).not.toHaveBeenCalled();
  });

  it('leaves Fast-backed Session titles to the Fast transcript generator', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation(user.id, 'fast-owned-title');
    const task = await taskFactory.create();
    await ensureSessionForTask(db, {
      taskId: task.id,
      fastConversationId: conversation.id,
      origin: 'fast_delegation',
    });

    await refreshTaskSessionTitle({
      taskId: task.id,
      mode: 'checkpoint',
    });

    expect(generateLlmTaskTitle).not.toHaveBeenCalled();
  });
});
