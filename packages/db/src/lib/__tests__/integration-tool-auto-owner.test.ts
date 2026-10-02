import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  findSessionPromptSenders,
  getIntegrationToolAutoOwner,
  resolveSessionIntegrationToolAutoOwner,
  userFactory,
  users,
} from '../../server';

const conversationIds: string[] = [];

afterEach(async () => {
  for (const id of conversationIds.splice(0)) {
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, id));
  }
});

async function seed() {
  const owner = await userFactory.create({
    name: 'Priya Raman',
    email: `priya.raman.${Date.now()}@ourco.example`,
  });
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: owner.id,
      surface: 'web',
      workspaceId: `W-${owner.id}`,
      conversationId: `C-${owner.id}`,
    })
    .returning({ id: fastAgentConversations.id });
  const conversationId = conversation!.id;
  conversationIds.push(conversationId);
  let turnSeq = 0;
  const prompt = (metadata: Record<string, unknown>) => {
    turnSeq += 1;
    return db.insert(fastAgentMessages).values({
      conversationId,
      eventId: `event-${turnSeq}`,
      turnId: `turn-${turnSeq}`,
      turnSeq,
      ts: 1_000 * turnSeq,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      contentBlocks: [{ type: 'text', text: `message ${turnSeq}` }],
      metadata,
      payload: {},
    });
  };
  return { owner, conversationId, prompt };
}

describe('findSessionPromptSenders', () => {
  it('names the sender only when one known person sent every prompt', async () => {
    const { owner, conversationId, prompt } = await seed();
    await expect(findSessionPromptSenders(conversationId)).resolves.toEqual({
      kind: 'none',
    });

    await prompt({ turnSource: 'human', userId: owner.id });
    await prompt({ turnSource: 'human', userId: owner.id });
    // Not a person's prompt, whoever it ran as.
    await prompt({ turnSource: 'platform_event', userId: 'somebody-else' });
    await expect(findSessionPromptSenders(conversationId)).resolves.toEqual({
      kind: 'one',
      userId: owner.id,
    });
    await expect(
      resolveSessionIntegrationToolAutoOwner({
        conversationId,
        ownerUserId: owner.id,
      }),
    ).resolves.toEqual({ name: 'Priya Raman', email: owner.email });
    // The one sender is not this session's owner.
    await expect(
      resolveSessionIntegrationToolAutoOwner({
        conversationId,
        ownerUserId: 'another-owner',
      }),
    ).resolves.toBeUndefined();

    // A reaction from somebody else is still somebody else in the session.
    await prompt({
      turnSource: 'human',
      inputKind: 'reaction',
      userId: 'participant',
    });
    await expect(findSessionPromptSenders(conversationId)).resolves.toEqual({
      kind: 'several',
    });
    await expect(
      resolveSessionIntegrationToolAutoOwner({
        conversationId,
        ownerUserId: owner.id,
      }),
    ).resolves.toBeUndefined();
  });

  it('counts an unknown sender, or another chat identity under the same account, as several', async () => {
    const unknown = await seed();
    await unknown.prompt({ turnSource: 'human' });
    await expect(
      findSessionPromptSenders(unknown.conversationId),
    ).resolves.toEqual({ kind: 'several' });

    const chat = await seed();
    await chat.prompt({
      turnSource: 'human',
      userId: chat.owner.id,
      senderExternalId: 'U-OWNER',
    });
    await expect(
      findSessionPromptSenders(chat.conversationId),
    ).resolves.toEqual({ kind: 'one', userId: chat.owner.id });
    await chat.prompt({
      turnSource: 'human',
      userId: chat.owner.id,
      senderExternalId: 'U-GUEST',
    });
    await expect(
      findSessionPromptSenders(chat.conversationId),
    ).resolves.toEqual({ kind: 'several' });
  });
});

describe('getIntegrationToolAutoOwner', () => {
  it('gives the name and email on the account, and nothing for no account', async () => {
    const { owner } = await seed();
    await expect(getIntegrationToolAutoOwner(owner.id)).resolves.toEqual({
      name: 'Priya Raman',
      email: owner.email,
    });
    await expect(
      getIntegrationToolAutoOwner('no-such-user'),
    ).resolves.toBeUndefined();

    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, owner.id));
    await expect(
      getIntegrationToolAutoOwner(owner.id),
    ).resolves.toBeUndefined();
  });
});
