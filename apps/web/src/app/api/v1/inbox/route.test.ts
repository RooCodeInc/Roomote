import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  db,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  sessions,
  userFactory,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/server/auth-context', () => ({ authorize: mocks.authorize }));
vi.mock('@roomote/sdk/server', () => ({
  syncFastAgentSlackTitleBestEffort: vi.fn(),
}));

import { GET } from './route';

async function createConversation(userId: string, title: string) {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'web',
      workspaceId: `ws-${title}`,
      conversationId: `conv-${title}-${Date.now()}`,
      title,
      compatibilityMessages: [],
    })
    .returning();
  const session = await ensureSessionForFastConversation(db, conversation!.id);
  await db
    .update(sessions)
    .set({ cachedStatus: 'needs_input' })
    .where(eq(sessions.id, session.id));
  return { conversation: conversation!, session };
}

async function insertMessage(input: {
  conversationId: string;
  eventId: string;
  eventType: `roomote_runtime.${string}`;
  payload: Record<string, unknown>;
  turnSeq: number;
}) {
  await db.insert(fastAgentMessages).values({
    conversationId: input.conversationId,
    eventId: input.eventId,
    turnId: 'turn-1',
    turnSeq: input.turnSeq,
    ts: input.turnSeq,
    eventType: input.eventType,
    role: 'assistant',
    contentBlocks: [],
    metadata: { visibleInTranscript: true },
    payload: input.payload,
    source: 'web',
  });
}

describe('GET /api/v1/inbox', () => {
  let userId: string;

  beforeAll(async () => {
    const user = await userFactory.create();
    userId = user.id;
    mocks.authorize.mockResolvedValue({
      success: true,
      userType: 'user',
      userId,
      isAdmin: false,
    });
  });

  it('lists unanswered questions and offers, skipping answered ones', async () => {
    const { conversation } = await createConversation(userId, 'Inbox test');
    const question = {
      id: 'q1',
      header: 'Deploy',
      question: 'Ship it?',
      isOther: false,
      isSecret: false,
      options: [{ label: 'Yes', description: 'Deploy now' }],
    };
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'req-open',
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      turnSeq: 1,
      payload: {
        requestId: 'req-open',
        status: 'pending',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        questions: [question],
      },
    });
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'req-done',
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
      turnSeq: 2,
      payload: {
        requestId: 'req-done',
        status: 'pending',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        questions: [question],
      },
    });
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'req-done-response',
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      turnSeq: 3,
      payload: {
        requestId: 'req-done',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        answers: { q1: { answers: ['Yes'] } },
        resolution: 'submitted',
      },
    });
    await insertMessage({
      conversationId: conversation.id,
      eventId: 'offer-open',
      eventType: ACP_ENVELOPE_EVENT_TYPES.CapabilityOffer,
      turnSeq: 4,
      payload: {
        offerId: 'offer-open',
        status: 'pending',
        capability: 'source_control',
        message: 'Connect GitHub?',
      },
    });

    const response = await GET(
      new NextRequest('https://roomote.test/api/v1/inbox'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const ids = body.items.map((item) => item.id).sort();
    expect(ids).toEqual(['capability_offer:offer-open', 'user_input:req-open']);
    const userInput = body.items.find((item) => item.kind === 'user_input')!;
    expect(userInput).toMatchObject({
      fastConversationId: conversation.id,
      sessionTitle: 'Inbox test',
      request: { requestId: 'req-open', questions: [question] },
      offer: null,
    });
    expect(typeof userInput.sessionId).toBe('string');
  });
});
