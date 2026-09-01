import { randomUUID } from 'node:crypto';

import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailSuppressions,
  agentmailUserMappings,
  authUsers,
  db,
  eq,
  userFactory,
} from '@roomote/db/server';

import {
  isAgentMailAddressSuppressed,
  resolveAgentMailOutboundAddress,
  startAgentMailConversation,
  suppressAgentMailAddress,
} from '../outbound';

const INBOX = 'roomote-outbound-test@agentmail.to';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

async function createVerifiedUser(email: string) {
  const user = await userFactory.create({ email });
  await db.insert(authUsers).values({
    id: user.id,
    name: user.name ?? 'Test User',
    email,
    emailVerified: true,
  });
  return user;
}

describe('agentmail suppression store (real database)', () => {
  it('is sticky and first-reason-wins', async () => {
    const address = uniqueEmail('bounced');

    expect(await isAgentMailAddressSuppressed(address)).toBe(false);
    expect(
      await suppressAgentMailAddress({
        emailAddress: address.toUpperCase(),
        reason: 'bounce',
        details: 'Permanent/General',
      }),
    ).toBe(true);
    expect(
      await suppressAgentMailAddress({
        emailAddress: address,
        reason: 'complaint',
      }),
    ).toBe(false);

    expect(await isAgentMailAddressSuppressed(address)).toBe(true);
    const row = await db.query.agentmailSuppressions.findFirst({
      where: eq(agentmailSuppressions.emailAddress, address),
    });
    expect(row?.reason).toBe('bounce');
  });
});

describe('resolveAgentMailOutboundAddress (real database)', () => {
  it('prefers the verified account email over a linked mapping', async () => {
    const accountEmail = uniqueEmail('account');
    const linkedEmail = uniqueEmail('linked');
    const user = await createVerifiedUser(accountEmail);
    await db.insert(agentmailUserMappings).values({
      emailAddress: linkedEmail,
      userId: user.id,
      source: 'link_code',
    });

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: true,
      emailAddress: accountEmail.toLowerCase(),
    });
  });

  it('falls back to a linked mapping when the account email is suppressed', async () => {
    const accountEmail = uniqueEmail('account');
    const linkedEmail = uniqueEmail('linked');
    const user = await createVerifiedUser(accountEmail);
    await db.insert(agentmailUserMappings).values({
      emailAddress: linkedEmail,
      userId: user.id,
      source: 'link_code',
    });
    await suppressAgentMailAddress({
      emailAddress: accountEmail,
      reason: 'unsubscribe',
    });

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: true,
      emailAddress: linkedEmail.toLowerCase(),
    });
  });

  it('refuses when every permitted address is suppressed', async () => {
    const accountEmail = uniqueEmail('account');
    const user = await createVerifiedUser(accountEmail);
    await suppressAgentMailAddress({
      emailAddress: accountEmail,
      reason: 'complaint',
    });

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: false,
      reason: 'suppressed',
    });
  });

  it('refuses users with no verified email and no mapping', async () => {
    const user = await userFactory.create();

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: false,
      reason: 'no_permitted_address',
    });
  });
});

describe('startAgentMailConversation (real database, stubbed AgentMail API)', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends with List-Unsubscribe headers and records a replyable conversation', async () => {
    const accountEmail = uniqueEmail('recipient');
    const user = await createVerifiedUser(accountEmail);
    const threadId = `thread_${randomUUID()}`;
    const messageId = `<${randomUUID()}@agentmail.to>`;

    const requests: {
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({ message_id: messageId, thread_id: threadId }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const sent = await startAgentMailConversation({
      userId: user.id,
      subject: 'Your GitHub installation was approved',
      text: 'The installation for acme was approved.',
      logContext: 'outbound-test',
    });

    expect(sent).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(
      `/v0/inboxes/${encodeURIComponent(INBOX)}/messages/send`,
    );
    expect(requests[0]!.body.to).toEqual([accountEmail.toLowerCase()]);
    const headers = requests[0]!.body.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toMatch(
      /^<.*\/api\/webhooks\/agentmail\/unsubscribe\?token=.*>$/,
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Idempotency key present: the client's internal 5xx/lost-response
    // retries replay the accepted send instead of emailing twice.
    expect(requests[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);

    const conversation = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.providerThreadId, threadId),
    });
    expect(conversation).toMatchObject({
      inboxId: INBOX,
      ownerUserId: user.id,
      latestOutboundMessageId: messageId,
      latestInboundMessageId: null,
    });

    const participant =
      await db.query.agentmailConversationParticipants.findFirst({
        where: eq(
          agentmailConversationParticipants.conversationId,
          conversation!.id,
        ),
      });
    expect(participant).toMatchObject({
      userId: user.id,
      role: 'owner',
      source: 'outbound',
    });
  });

  it('does not call the API for a suppressed recipient', async () => {
    const accountEmail = uniqueEmail('suppressed');
    const user = await createVerifiedUser(accountEmail);
    await suppressAgentMailAddress({
      emailAddress: accountEmail,
      reason: 'unsubscribe',
    });

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const sent = await startAgentMailConversation({
      userId: user.id,
      subject: 'Should never send',
      text: 'nope',
      logContext: 'outbound-test',
    });

    expect(sent).toBe(false);
    expect(called).toBe(false);
  });
});
