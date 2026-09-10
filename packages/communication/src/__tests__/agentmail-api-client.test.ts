import { describe, expect, it } from 'vitest';

import { AgentMailApiClient, AgentMailApiError } from '../agentmail-provider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AgentMailApiClient.listInboxes', () => {
  it('follows next_page_token pagination and aggregates every page', async () => {
    const urls: string[] = [];
    const pages = [
      {
        inboxes: [
          { inbox_id: 'a@agentmail.to' },
          { inbox_id: 'b@agentmail.to' },
        ],
        next_page_token: 'page-2',
      },
      {
        inboxes: [{ inbox_id: 'c@agentmail.to' }],
        next_page_token: '',
      },
    ];
    const client = new AgentMailApiClient({
      apiKey: 'am_test',
      apiBaseUrl: 'https://agentmail.test',
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse(pages[urls.length - 1]);
      }) as typeof fetch,
    });

    const listed = await client.listInboxes();

    expect(urls).toEqual([
      'https://agentmail.test/v0/inboxes',
      'https://agentmail.test/v0/inboxes?page_token=page-2',
    ]);
    expect((listed.inboxes ?? []).map((inbox) => inbox.inbox_id)).toEqual([
      'a@agentmail.to',
      'b@agentmail.to',
      'c@agentmail.to',
    ]);
  });

  it('returns a single page unchanged when no token is present', async () => {
    let calls = 0;
    const client = new AgentMailApiClient({
      apiKey: 'am_test',
      apiBaseUrl: 'https://agentmail.test',
      fetch: (async () => {
        calls += 1;
        return jsonResponse({ inboxes: [{ inbox_id: 'only@agentmail.to' }] });
      }) as typeof fetch,
    });

    const listed = await client.listInboxes();
    expect(calls).toBe(1);
    expect(listed.inboxes).toHaveLength(1);
  });
});

describe('AgentMailApiError', () => {
  it('carries the HTTP status of non-2xx responses', async () => {
    const client = new AgentMailApiClient({
      apiKey: 'am_test',
      apiBaseUrl: 'https://agentmail.test',
      fetch: (async () =>
        jsonResponse({ error: 'forbidden' }, 403)) as typeof fetch,
    });

    const error = await client
      .getMessage('inbox@agentmail.to', 'missing')
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentMailApiError);
    expect((error as AgentMailApiError).status).toBe(403);
  });
});

describe('AgentMailApiClient webhook scoping', () => {
  function recordingClient() {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const client = new AgentMailApiClient({
      apiKey: 'am_test',
      apiBaseUrl: 'https://agentmail.test',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ inboxes: [], webhooks: [] });
      }) as typeof fetch,
    });
    return { client, calls };
  }

  it('manages webhooks under the inbox for an inbox-scoped key', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const client = new AgentMailApiClient({
      apiKey: 'am_inbox_scoped',
      apiBaseUrl: 'https://agentmail.test',
      webhookInboxId: 'roomote@roomote.me',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ inboxes: [], webhooks: [] });
      }) as typeof fetch,
    });

    await client.listInboxes();
    await client.listWebhooks();
    await client.createWebhook({
      url: 'https://app.example.com/api/webhooks/agentmail',
      inboxIds: ['roomote@roomote.me'],
      eventTypes: ['message.received'],
    });
    await client.updateWebhook('wh-1', {
      eventTypes: ['message.received', 'message.bounced'],
    });
    await client.deleteWebhook('wh-1');

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://agentmail.test/v0/inboxes',
      'GET https://agentmail.test/v0/inboxes/roomote%40roomote.me/webhooks',
      'POST https://agentmail.test/v0/inboxes/roomote%40roomote.me/webhooks',
      'PATCH https://agentmail.test/v0/inboxes/roomote%40roomote.me/webhooks/wh-1',
      'DELETE https://agentmail.test/v0/inboxes/roomote%40roomote.me/webhooks/wh-1',
    ]);
    // The path pins the inbox: no inbox list on create.
    expect(calls[2]?.body).toEqual({
      url: 'https://app.example.com/api/webhooks/agentmail',
      event_types: ['message.received'],
    });
    expect(calls[3]?.body).toEqual({
      event_types: ['message.received', 'message.bounced'],
    });
    expect(client.webhookInboxId).toBe('roomote@roomote.me');
  });

  it('stays at organization level without an inbox', async () => {
    const { client, calls } = recordingClient();
    await client.listWebhooks();
    await client.createWebhook({
      url: 'https://app.example.com/api/webhooks/agentmail',
      inboxIds: ['roomote@agentmail.to'],
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://agentmail.test/v0/webhooks',
      'https://agentmail.test/v0/webhooks',
    ]);
    expect(calls[1]?.body).toEqual({
      url: 'https://app.example.com/api/webhooks/agentmail',
      inbox_ids: ['roomote@agentmail.to'],
    });
    expect(client.webhookInboxId).toBeNull();
  });

  it('sends only a full event-type replacement on update, never an empty list', async () => {
    const { client, calls } = recordingClient();
    await client.updateWebhook('wh-1', {
      eventTypes: ['message.received', 'message.bounced'],
    });
    await client.updateWebhook('wh-1', { eventTypes: [] });

    expect(calls[0]?.body).toEqual({
      event_types: ['message.received', 'message.bounced'],
    });
    // An empty list must leave event types unchanged, never clear them.
    expect(calls[1]?.body).toEqual({});
  });
});
