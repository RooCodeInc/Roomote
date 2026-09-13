import { randomUUID } from 'node:crypto';

import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailSuppressions,
  authUsers,
  db,
  eq,
  userFactory,
} from '@roomote/db/server';

import { createAgentMailCommunicationProviderFromRuntimeCredentials } from '../../agentmail-communication';
import { advanceAgentMailInboundAnchor } from '../conversation-store';
import {
  canStartAgentMailConversationWithUser,
  isAgentMailAddressSuppressed,
  listAgentMailOutboundIdentities,
  prepareAgentMailConversation,
  resolveAgentMailOutboundAddress,
  resolveAgentMailOutboundIdentity,
  sendAgentMailSystemEmail,
  startAgentMailConversation,
  startAgentMailConversationWithResult,
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
  it('resolves the verified account email', async () => {
    const accountEmail = uniqueEmail('account');
    const user = await createVerifiedUser(accountEmail);

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: true,
      emailAddress: accountEmail.toLowerCase(),
    });
  });

  it('refuses when the account email is suppressed', async () => {
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

  it('refuses users with no verified email', async () => {
    const user = await userFactory.create();

    expect(await resolveAgentMailOutboundAddress(user.id)).toEqual({
      ok: false,
      reason: 'no_permitted_address',
    });
  });

  it('lists the verified account identity for automation selection', async () => {
    const accountEmail = uniqueEmail('verified');
    const user = await createVerifiedUser(accountEmail);

    const identities = await listAgentMailOutboundIdentities(user.id);

    expect(identities).toEqual([
      {
        id: expect.stringMatching(`^verified:${user.id}:`),
        emailAddress: accountEmail.toLowerCase(),
        kind: 'verified',
      },
    ]);
    expect(
      await resolveAgentMailOutboundIdentity(user.id, identities[0]!.id),
    ).toEqual({ ok: true, emailAddress: accountEmail.toLowerCase() });
  });

  it('revokes an exact identity instead of substituting another address', async () => {
    const accountEmail = uniqueEmail('selected');
    const user = await createVerifiedUser(accountEmail);
    const [identity] = await listAgentMailOutboundIdentities(user.id);
    await db
      .update(authUsers)
      .set({ emailVerified: false })
      .where(eq(authUsers.id, user.id));

    expect(
      await resolveAgentMailOutboundIdentity(user.id, identity!.id),
    ).toEqual({ ok: false, reason: 'no_permitted_address' });
  });
});

describe('startAgentMailConversation (real database, stubbed AgentMail API)', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
  });

  it('refuses to send while the email channel is disabled', async () => {
    const accountEmail = uniqueEmail('gated');
    const user = await createVerifiedUser(accountEmail);
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    process.env.R_EMAIL_CHANNEL_ENABLED = 'false';
    try {
      // The shared reply-path factory is the kill switch for conversations
      // that were admitted before the flag was turned off.
      expect(
        await createAgentMailCommunicationProviderFromRuntimeCredentials(),
      ).toBeNull();
      expect(await canStartAgentMailConversationWithUser(user.id)).toBe(false);
      expect(
        await startAgentMailConversation({
          userId: user.id,
          subject: 'Gated',
          text: 'nope',
          logContext: 'outbound-test',
        }),
      ).toBe(false);
      expect(
        await sendAgentMailSystemEmail({
          to: accountEmail,
          subject: 'Gated',
          text: 'nope',
          logContext: 'outbound-test',
        }),
      ).toEqual({ sent: false, reason: 'channel_disabled' });
      expect(called).toBe(false);
    } finally {
      process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not send until the prepared automation conversation has a report', async () => {
    const accountEmail = uniqueEmail('automation-prepared');
    const user = await createVerifiedUser(accountEmail);
    const [identity] = await listAgentMailOutboundIdentities(user.id);
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          message_id: `<${randomUUID()}@agentmail.to>`,
          thread_id: 'thread_final_report',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const prepared = await prepareAgentMailConversation({
      userId: user.id,
      identityId: identity!.id,
      subject: 'Automation report',
      conversationKey: `automation-run-${randomUUID()}`,
    });
    expect(prepared).not.toBeNull();
    expect(requests).toHaveLength(0);

    const provider =
      await createAgentMailCommunicationProviderFromRuntimeCredentials();
    await provider!.postMessage({
      channelId: INBOX,
      threadId: prepared!.conversationId,
      text: 'Final report',
      textFormat: 'markdown',
      idempotencyKey: 'automation-final-report',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('/messages/send');
    expect(requests[0]!.body).toMatchObject({
      to: [accountEmail.toLowerCase()],
      subject: 'Automation report',
      text: expect.stringContaining('Final report'),
    });
    expect(String(requests[0]!.body.text)).not.toContain('is running');
    const conversation = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.id, prepared!.conversationId),
    });
    expect(conversation).toMatchObject({
      providerThreadId: 'thread_final_report',
      latestOutboundMessageId: expect.any(String),
    });
    const participant =
      await db.query.agentmailConversationParticipants.findFirst({
        where: eq(
          agentmailConversationParticipants.conversationId,
          prepared!.conversationId,
        ),
      });
    expect(participant).toMatchObject({
      userId: user.id,
      providerThreadId: 'thread_final_report',
      source: 'outbound',
    });
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

  it('refuses later delivery after the selected identity is revoked', async () => {
    const accountEmail = uniqueEmail('automation');
    const changedEmail = uniqueEmail('changed');
    const user = await createVerifiedUser(accountEmail);
    const [identity] = await listAgentMailOutboundIdentities(user.id);
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          message_id: `<${randomUUID()}@agentmail.to>`,
          thread_id: `thread_${randomUUID()}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const started = await startAgentMailConversationWithResult({
      userId: user.id,
      identityId: identity!.id,
      subject: 'Automation report',
      text: 'The automation is running.',
      logContext: 'automation-test',
      clientSendId: 'automation-run-1',
    });
    expect(started).toMatchObject({ sent: true, conversation: {} });
    await db
      .update(authUsers)
      .set({ email: changedEmail, emailVerified: true })
      .where(eq(authUsers.id, user.id));

    const provider =
      await createAgentMailCommunicationProviderFromRuntimeCredentials();
    await expect(
      provider!.postMessage({
        channelId: INBOX,
        threadId: started.sent
          ? started.conversation?.conversationId
          : undefined,
        text: 'Final report',
        textFormat: 'markdown',
        idempotencyKey: 'automation-report-1',
      }),
    ).rejects.toThrow('recipient identity is no longer eligible');
    expect(requests).toHaveLength(1);
  });

  it('threads the report on its own root message until someone replies', async () => {
    const accountEmail = uniqueEmail('automation');
    const user = await createVerifiedUser(accountEmail);
    const [identity] = await listAgentMailOutboundIdentities(user.id);
    const rootMessageId = `<${randomUUID()}@agentmail.to>`;
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          message_id:
            requests.length === 1
              ? rootMessageId
              : `<${randomUUID()}@agentmail.to>`,
          thread_id: `thread_${randomUUID()}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const started = await startAgentMailConversationWithResult({
      userId: user.id,
      identityId: identity!.id,
      subject: 'Automation report',
      text: 'The automation is running.',
      logContext: 'automation-test',
      clientSendId: 'automation-run-2',
    });
    if (!started.sent || !started.conversation) {
      throw new Error('expected the root email to be recorded');
    }

    const provider =
      await createAgentMailCommunicationProviderFromRuntimeCredentials();
    await provider!.postMessage({
      channelId: INBOX,
      threadId: started.conversation.conversationId,
      text: 'Final report',
      textFormat: 'markdown',
      idempotencyKey: 'automation-report-2',
    });
    expect(requests[1]!.url).toContain(
      `/messages/${encodeURIComponent(rootMessageId)}/reply`,
    );
    expect(requests[1]!.body.to).toEqual([accountEmail.toLowerCase()]);
  });

  it('answers whoever last wrote in, even on an outbound-initiated thread', async () => {
    const accountEmail = uniqueEmail('owner');
    const colleagueEmail = uniqueEmail('colleague');
    const user = await createVerifiedUser(accountEmail);
    const [identity] = await listAgentMailOutboundIdentities(user.id);
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          message_id: `<${randomUUID()}@agentmail.to>`,
          thread_id: `thread_${randomUUID()}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const started = await startAgentMailConversationWithResult({
      userId: user.id,
      identityId: identity!.id,
      subject: 'Automation report',
      text: 'The automation is running.',
      logContext: 'automation-test',
      clientSendId: 'automation-run-3',
    });
    if (!started.sent || !started.conversation) {
      throw new Error('expected the root email to be recorded');
    }
    const colleagueMessageId = `<${randomUUID()}@example.com>`;
    expect(
      await advanceAgentMailInboundAnchor({
        conversationId: started.conversation.conversationId,
        messageId: colleagueMessageId,
        providerTimestamp: new Date(),
        senderEmail: colleagueEmail,
        senderUserId: null,
      }),
    ).toBe(true);

    const provider =
      await createAgentMailCommunicationProviderFromRuntimeCredentials();
    await provider!.postMessage({
      channelId: INBOX,
      threadId: started.conversation.conversationId,
      text: 'Answer',
      textFormat: 'markdown',
      idempotencyKey: 'automation-report-3',
    });
    expect(requests[1]!.url).toContain(
      `/messages/${encodeURIComponent(colleagueMessageId)}/reply`,
    );
    expect(requests[1]!.body.to).toEqual([colleagueEmail.toLowerCase()]);
  });
});

describe('sendAgentMailSystemEmail (real database, stubbed AgentMail API)', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubSend() {
    const requests: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ message_id: `<${randomUUID()}@agentmail.to>` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    return requests;
  }

  it('sends to an unverified address with no unsubscribe header', async () => {
    const requests = stubSend();
    const to = uniqueEmail('unverified');

    const result = await sendAgentMailSystemEmail({
      to,
      subject: 'Verify your email for Roomote',
      text: '[Verify](https://example.test/verify)',
      logContext: 'outbound-test',
    });

    expect(result).toEqual({ sent: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.to).toEqual([to.toLowerCase()]);
    expect(requests[0]!.body.headers).toBeUndefined();
    expect(String(requests[0]!.body.text)).not.toContain('unsubscribe');
  });

  it('still sends to an address that unsubscribed from notifications', async () => {
    const requests = stubSend();
    const to = uniqueEmail('unsubscribed');
    await suppressAgentMailAddress({ emailAddress: to, reason: 'unsubscribe' });

    const result = await sendAgentMailSystemEmail({
      to,
      subject: 'Reset your Roomote password',
      text: 'reset',
      logContext: 'outbound-test',
    });

    expect(result).toEqual({ sent: true });
    expect(requests).toHaveLength(1);
  });

  it('never sends to a bounced or complained address', async () => {
    const requests = stubSend();
    const to = uniqueEmail('bounced');
    await suppressAgentMailAddress({ emailAddress: to, reason: 'bounce' });

    const result = await sendAgentMailSystemEmail({
      to,
      subject: 'Verify your email for Roomote',
      text: 'verify',
      logContext: 'outbound-test',
    });

    expect(result).toEqual({ sent: false, reason: 'suppressed' });
    expect(requests).toHaveLength(0);
  });
});
