import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  eq,
  userFactory,
} from '@roomote/db/server';

import { refreshFastAgentSessionTitle } from '../fast-agent-title';

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

  return conversation!;
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
    expect(updated?.title).toBe('Rotate the API keys');
    expect(updated?.llmTitleCheckpoint).toBe(1);
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
});
