/**
 * Real-database coverage for Fast structured-input request resolution: the
 * `request_user_input` request/response transcript events and the
 * `needs_input` derivation via hasFastConversationPendingUserInput. Mocked-db
 * tests cannot prove the SQL payload probing actually resolves.
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  fastAgentConversations,
  fastAgentMessages,
  userFactory,
  users,
} from '../server';
import { eq } from 'drizzle-orm';
import {
  deriveSessionStatus,
  hasFastConversationPendingUserInput,
} from '../lib/sessions';

let createdUserId: string | null = null;
const createdConversationIds: string[] = [];
const createdMessageIds: string[] = [];

async function createConversation(): Promise<string> {
  if (!createdUserId) {
    const user = await userFactory.create();
    createdUserId = user.id;
  }
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      surface: 'web',
      userId: createdUserId,
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      title: 'Pending input test',
    })
    .returning({ id: fastAgentConversations.id });
  if (!conversation) throw new Error('conversation insert failed');
  createdConversationIds.push(conversation.id);
  return conversation.id;
}

async function appendMessage(input: {
  conversationId: string;
  eventType: `roomote_runtime.${string}`;
  payload: Record<string, unknown>;
  ts: number;
}): Promise<string> {
  const [message] = await db
    .insert(fastAgentMessages)
    .values({
      conversationId: input.conversationId,
      eventId: `evt-${randomUUID()}`,
      turnId: `turn-${randomUUID()}`,
      turnSeq: 0,
      ts: input.ts,
      eventType: input.eventType,
      role: 'assistant',
      contentBlocks: [],
      metadata: { visibleInTranscript: true },
      payload: input.payload,
      source: 'web',
    })
    .returning({ id: fastAgentMessages.id });
  if (!message) throw new Error('message insert failed');
  createdMessageIds.push(message.id);
  return message.id;
}

afterAll(async () => {
  for (const conversationId of createdConversationIds) {
    // Messages cascade with the conversation.
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversationId));
  }
  if (createdUserId) {
    await db.delete(users).where(eq(users.id, createdUserId));
  }
});

describe('fast conversation pending structured input', () => {
  it('reports pending until a response event resolves the latest request', async () => {
    const conversationId = await createConversation();
    const requestId = `rui:${randomUUID()}`;

    await appendMessage({
      conversationId,
      eventType: 'roomote_runtime.request_user_input' as const,
      payload: { requestId, status: 'pending', questions: [] },
      ts: 1_000,
    });
    await expect(hasPending(conversationId)).resolves.toBe(true);

    await appendMessage({
      conversationId,
      eventType: 'roomote_runtime.request_user_input_response' as const,
      payload: { requestId, answers: {}, resolution: 'submitted' },
      ts: 2_000,
    });
    await expect(hasPending(conversationId)).resolves.toBe(false);

    // A newer unanswered request supersedes the resolved one.
    const newerRequestId = `rui:${randomUUID()}`;
    await appendMessage({
      conversationId,
      eventType: 'roomote_runtime.request_user_input' as const,
      payload: { requestId: newerRequestId, status: 'pending', questions: [] },
      ts: 3_000,
    });
    await expect(hasPending(conversationId)).resolves.toBe(true);
  });

  it('derives needs_input from the pending-input flag before active state', async () => {
    expect(
      deriveSessionStatus({
        conversationResponding: true,
        conversationPendingInput: true,
        tasks: [],
      }),
    ).toBe('needs_input');
    expect(
      deriveSessionStatus({ conversationResponding: true, tasks: [] }),
    ).toBe('active');
    expect(
      deriveSessionStatus({ conversationResponding: false, tasks: [] }),
    ).toBe('ready');
  });
});

async function hasPending(conversationId: string): Promise<boolean> {
  return hasFastConversationPendingUserInput(db, conversationId);
}
