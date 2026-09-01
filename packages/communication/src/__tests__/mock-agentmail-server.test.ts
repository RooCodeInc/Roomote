import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MockAgentMailServer,
  signSvixPayload,
  type MockAgentMailState,
  type MockAgentMailWebhook,
} from '../mock-agentmail-server';

const API_KEY = 'mock-agentmail-api-key';
const INBOX_ID = 'roomote@agentmail.to';

function baseState(): MockAgentMailState {
  return {
    inboxes: [
      {
        inbox_id: INBOX_ID,
        username: 'roomote',
        domain: 'agentmail.to',
        display_name: 'Roomote',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
}

async function startServer(state: MockAgentMailState = baseState()) {
  const server = new MockAgentMailServer({ state });
  const baseUrl = await server.start();
  return { server, baseUrl };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

type ReceivedDelivery = {
  headers: IncomingMessage['headers'];
  body: string;
};

describe('MockAgentMailServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  function onCleanup(fn: () => Promise<void>) {
    cleanups.push(fn);
  }

  it('rejects API requests without a bearer token', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const response = await fetch(`${baseUrl}/v0/inboxes`);
    expect(response.status).toBe(401);
  });

  it('rejects requests carrying an API key outside acceptedApiKeys', async () => {
    const state = baseState();
    state.acceptedApiKeys = ['some-other-key'];
    const { server, baseUrl } = await startServer(state);
    onCleanup(() => server.stop());

    const listing = await api(baseUrl, 'GET', '/v0/inboxes');
    expect(listing.status).toBe(401);
  });

  it('creates inboxes idempotently per client_id', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const first = await api(baseUrl, 'POST', '/v0/inboxes', {
      username: 'support',
      client_id: 'support-inbox',
    });
    expect(first.status).toBe(200);
    expect(first.body.inbox_id).toBe('support@agentmail.to');

    const second = await api(baseUrl, 'POST', '/v0/inboxes', {
      username: 'support',
      client_id: 'support-inbox',
    });
    expect(second.status).toBe(200);
    expect(second.body.inbox_id).toBe('support@agentmail.to');

    const listing = await api(baseUrl, 'GET', '/v0/inboxes');
    expect(listing.body.inboxes).toHaveLength(2);

    const fetched = await api(
      baseUrl,
      'GET',
      '/v0/inboxes/support%40agentmail.to',
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.username).toBe('support');
  });

  it('registers webhooks idempotently per client_id and supports PATCH/DELETE', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const first = await api(baseUrl, 'POST', '/v0/webhooks', {
      url: 'https://roomote.example.test/api/webhooks/agentmail',
      client_id: 'roomote-webhook',
      event_types: ['message.received'],
    });
    expect(first.status).toBe(200);
    expect(String(first.body.secret)).toMatch(/^whsec_/);

    const second = await api(baseUrl, 'POST', '/v0/webhooks', {
      url: 'https://roomote.example.test/api/webhooks/agentmail',
      client_id: 'roomote-webhook',
    });
    expect(second.body.webhook_id).toBe(first.body.webhook_id);
    expect(second.body.secret).toBe(first.body.secret);

    const patched = await api(
      baseUrl,
      'PATCH',
      `/v0/webhooks/${first.body.webhook_id}`,
      { url: 'https://roomote.example.test/api/webhooks/agentmail-v2' },
    );
    expect(patched.body.url).toBe(
      'https://roomote.example.test/api/webhooks/agentmail-v2',
    );

    const deleted = await api(
      baseUrl,
      'DELETE',
      `/v0/webhooks/${first.body.webhook_id}`,
    );
    expect(deleted.status).toBe(200);
    expect((await api(baseUrl, 'GET', '/v0/webhooks')).body.webhooks).toEqual(
      [],
    );
  });

  it('delivers message.received events with a valid Svix signature', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const registered = await api(baseUrl, 'POST', '/v0/webhooks', {
      url: listener.url,
      inbox_ids: [INBOX_ID],
      event_types: ['message.received'],
    });
    const secret = String(registered.body.secret);

    const result = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      subject: 'Flaky login test',
      text: 'Hi Roomote — can you look into the flaky login test?',
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.status).toBe(200);
    expect(received).toHaveLength(1);

    const delivery = received[0]!;
    const svixId = String(delivery.headers['svix-id']);
    const timestamp = String(delivery.headers['svix-timestamp']);
    const signature = String(delivery.headers['svix-signature']);

    // Verify the way the `svix` package does: HMAC-SHA256 over
    // `${id}.${timestamp}.${body}` keyed with the base64-decoded secret.
    const expected = createHmac(
      'sha256',
      Buffer.from(secret.slice('whsec_'.length), 'base64'),
    )
      .update(`${svixId}.${timestamp}.${delivery.body}`)
      .digest('base64');
    expect(signature).toBe(`v1,${expected}`);
    expect(signature).toBe(
      signSvixPayload({
        secret,
        svixId,
        timestamp,
        payload: delivery.body,
      }),
    );

    const payload = JSON.parse(delivery.body) as {
      type: string;
      event_type: string;
      event_id: string;
      message: Record<string, unknown>;
      thread: Record<string, unknown>;
    };
    expect(payload.type).toBe('event');
    expect(payload.event_type).toBe('message.received');
    expect(payload.event_id).toBe(result.eventId);
    expect(payload.message).toMatchObject({
      message_id: result.messageId,
      thread_id: result.threadId,
      inbox_id: INBOX_ID,
      from: 'grace@example.com',
      to: [INBOX_ID],
      subject: 'Flaky login test',
      text: 'Hi Roomote — can you look into the flaky login test?',
      extracted_text: 'Hi Roomote — can you look into the flaky login test?',
      attachments: [],
    });
    expect(payload.thread).toEqual({
      thread_id: result.threadId,
      last_message_id: result.messageId,
      message_count: 1,
    });
  });

  it('delivers bounce and complaint events with real payload shapes', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', {
      url: listener.url,
      inbox_ids: [INBOX_ID],
      event_types: ['message.bounced', 'message.complained'],
    });

    const bounce = await server.dispatch({
      kind: 'bounce',
      inboxId: INBOX_ID,
      recipients: ['gone@example.com'],
    });
    expect(bounce.deliveries).toHaveLength(1);
    expect(bounce.deliveries[0]?.status).toBe(200);

    const complaint = await server.dispatch({
      kind: 'complaint',
      inboxId: INBOX_ID,
      recipients: ['angry@example.com'],
    });
    expect(complaint.deliveries).toHaveLength(1);

    const bouncePayload = JSON.parse(received[0]!.body) as Record<
      string,
      unknown
    >;
    expect(bouncePayload.event_type).toBe('message.bounced');
    // Bounce recipients are objects; complaint recipients are bare strings.
    expect(bouncePayload.bounce).toMatchObject({
      inbox_id: INBOX_ID,
      type: 'Permanent',
      recipients: [{ address: 'gone@example.com', status: 'bounced' }],
    });

    const complaintPayload = JSON.parse(received[1]!.body) as Record<
      string,
      unknown
    >;
    expect(complaintPayload.event_type).toBe('message.complained');
    expect(complaintPayload.complaint).toMatchObject({
      inbox_id: INBOX_ID,
      recipients: ['angry@example.com'],
    });
  });

  it('redelivers duplicates and explicit redeliveries with the same svix-id', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', { url: listener.url });

    const original = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      text: 'first delivery',
    });

    const duplicate = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      duplicate: true,
    });
    expect(duplicate.eventId).toBe(original.eventId);
    expect(duplicate.svixId).toBe(original.svixId);
    expect(duplicate.messageId).toBe(original.messageId);

    const redelivered = await server.dispatch({
      kind: 'redeliver',
      eventId: original.eventId,
    });
    expect(redelivered.svixId).toBe(original.svixId);

    expect(received).toHaveLength(3);
    expect(new Set(received.map((d) => d.headers['svix-id']))).toEqual(
      new Set([original.svixId]),
    );
    expect(received[1]!.body).toBe(received[0]!.body);
    expect(received[2]!.body).toBe(received[0]!.body);

    // No second inbound message was stored for the duplicate delivery.
    const inbound = (server.getState().messages ?? []).filter(
      (m) => m.direction === 'inbound',
    );
    expect(inbound).toHaveLength(1);
  });

  it('omits text and html from oversize deliveries but keeps the stored message intact', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', { url: listener.url });

    const result = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      subject: 'Huge attachment recap',
      text: 'pretend this is 2MB of text',
      html: '<p>pretend this is 2MB of html</p>',
      oversize: true,
    });

    const payload = JSON.parse(received[0]!.body) as {
      message: Record<string, unknown>;
    };
    expect(payload.message.text).toBeUndefined();
    expect(payload.message.extracted_text).toBeUndefined();
    expect(payload.message.html).toBeUndefined();
    expect(payload.message.subject).toBe('Huge attachment recap');

    // Re-fetching the message by id still returns the full content.
    const fetched = await api(
      baseUrl,
      'GET',
      `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages/${result.messageId}`,
    );
    expect(fetched.body.text).toBe('pretend this is 2MB of text');
    expect(fetched.body.html).toBe('<p>pretend this is 2MB of html</p>');
  });

  it('stamps an Auto-Submitted header on autoSubmitted events', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', { url: listener.url });

    await server.dispatch({
      inboxId: INBOX_ID,
      from: 'noreply@example.com',
      text: 'Your build failed.',
      autoSubmitted: true,
    });

    const payload = JSON.parse(received[0]!.body) as {
      message: { headers?: Record<string, string> };
    };
    expect(payload.message.headers).toEqual({
      'auto-submitted': 'auto-generated',
    });
  });

  it('scopes deliveries to matching inbox_ids and event_types', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const state = baseState();
    state.inboxes.push({
      inbox_id: 'other@agentmail.to',
      username: 'other',
      domain: 'agentmail.to',
      created_at: '2026-08-01T00:00:00.000Z',
    });
    const { server, baseUrl } = await startServer(state);
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', {
      url: listener.url,
      inbox_ids: ['other@agentmail.to'],
    });
    await api(baseUrl, 'POST', '/v0/webhooks', {
      url: listener.url,
      event_types: ['message.bounced'],
    });

    const result = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      text: 'nobody should hear about this',
    });

    expect(result.deliveries).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('threads inbound follow-ups and replies through the same thread', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const first = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      subject: 'Flaky login test',
      text: 'Can you take a look?',
    });

    const reply = await api(
      baseUrl,
      'POST',
      `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages/${first.messageId}/reply`,
      { text: 'On it — taking a look now.' },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.thread_id).toBe(first.threadId);

    const followUp = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      text: 'thanks!',
      threadId: first.threadId,
    });
    expect(followUp.threadId).toBe(first.threadId);

    const messages = server.getState().messages ?? [];
    const outbound = messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      thread_id: first.threadId,
      from: INBOX_ID,
      to: ['grace@example.com'],
      subject: 'Re: Flaky login test',
      text: 'On it — taking a look now.',
      in_reply_to: first.messageId,
      references: [first.messageId],
    });

    const followUpMessage = messages.find(
      (m) => m.message_id === followUp.messageId,
    );
    expect(followUpMessage?.in_reply_to).toBe(outbound[0]?.message_id);
  });

  it('dedupes replies on the Idempotency-Key header', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const inbound = await server.dispatch({
      inboxId: INBOX_ID,
      from: 'grace@example.com',
      text: 'ping',
    });

    const replyPath = `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages/${inbound.messageId}/reply`;
    const first = await api(
      baseUrl,
      'POST',
      replyPath,
      { text: 'pong' },
      { 'idempotency-key': 'reply-attempt-1' },
    );
    const retry = await api(
      baseUrl,
      'POST',
      replyPath,
      { text: 'pong' },
      { 'idempotency-key': 'reply-attempt-1' },
    );

    expect(retry.body.message_id).toBe(first.body.message_id);
    expect(retry.body.thread_id).toBe(first.body.thread_id);
    expect(
      (server.getState().messages ?? []).filter(
        (m) => m.direction === 'outbound',
      ),
    ).toHaveLength(1);
  });

  it('starts a new thread on send and records it as outbound', async () => {
    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    const sent = await api(
      baseUrl,
      'POST',
      `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages/send`,
      {
        to: ['grace@example.com'],
        subject: 'Task complete',
        text: 'All done — the fix is on develop.',
      },
    );
    expect(sent.status).toBe(200);
    expect(String(sent.body.message_id)).toMatch(/^msg_/);
    expect(String(sent.body.thread_id)).toMatch(/^thread_/);

    const message = (server.getState().messages ?? []).find(
      (m) => m.message_id === sent.body.message_id,
    );
    expect(message).toMatchObject({
      direction: 'outbound',
      from: INBOX_ID,
      to: ['grace@example.com'],
      subject: 'Task complete',
    });
    expect(message?.in_reply_to).toBeUndefined();
  });

  it('exposes state and accepts inbound events through the /mock endpoints', async () => {
    const received: ReceivedDelivery[] = [];
    const listener = await startStubWebhook(received);
    onCleanup(() => listener.stop());

    const { server, baseUrl } = await startServer();
    onCleanup(() => server.stop());

    await api(baseUrl, 'POST', '/v0/webhooks', { url: listener.url });

    const eventResponse = await fetch(`${baseUrl}/mock/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inboxId: INBOX_ID,
        from: 'grace@example.com',
        subject: 'Hello',
        text: 'via the control surface',
      }),
    });
    expect(eventResponse.status).toBe(200);
    const dispatched = (await eventResponse.json()) as {
      ok: boolean;
      dispatchResult: { deliveries: Array<{ status: number }> };
    };
    expect(dispatched.ok).toBe(true);
    expect(dispatched.dispatchResult.deliveries[0]?.status).toBe(200);

    const stateResponse = await fetch(`${baseUrl}/mock/state`);
    const state = (await stateResponse.json()) as MockAgentMailState;
    expect(state.inboxes).toHaveLength(1);
    expect(state.webhooks).toHaveLength(1);
    expect(state.messages).toHaveLength(1);
    expect(state.events).toHaveLength(1);

    // POST /mock/state resets the harness in place.
    const resetResponse = await fetch(`${baseUrl}/mock/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseState()),
    });
    expect(resetResponse.status).toBe(200);
    expect(server.getState().messages ?? []).toHaveLength(0);
    expect(server.getState().webhooks ?? []).toHaveLength(0);
  });

  it('mints signing secrets for seeded webhooks that omit one', async () => {
    const state = baseState();
    state.webhooks = [
      {
        webhook_id: 'wh_seeded_1',
        url: 'https://roomote.example.test/api/webhooks/agentmail',
        secret: '',
        enabled: true,
        created_at: '2026-08-01T00:00:00.000Z',
      } as MockAgentMailWebhook,
    ];
    const { server } = await startServer(state);
    onCleanup(() => server.stop());

    expect(server.getState().webhooks?.[0]?.secret).toMatch(/^whsec_/);
  });
});

async function startStubWebhook(
  received: ReceivedDelivery[],
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      received.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/api/webhooks/agentmail`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
