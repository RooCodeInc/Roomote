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

describe('AgentMailApiClient pod scoping', () => {
  function recordingClient(podId?: string) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const client = new AgentMailApiClient({
      apiKey: 'am_test',
      apiBaseUrl: 'https://agentmail.test',
      ...(podId ? { podId } : {}),
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

  it('routes inbox and webhook management through the pod, messages through the inbox', async () => {
    const { client, calls } = recordingClient('pod_acme');

    await client.listInboxes();
    await client.createInbox({ username: 'roomote', clientId: 'roomote-1' });
    await client.getInbox('roomote@agentmail.to');
    await client.updateInbox('roomote@agentmail.to', {
      displayName: 'Roomote',
    });
    await client.listWebhooks();
    await client.createWebhook({
      url: 'https://app.example.com/api/webhooks/agentmail',
      inboxIds: ['roomote@agentmail.to'],
    });
    await client.updateWebhook('wh-1', { addInboxIds: ['a@agentmail.to'] });
    await client.deleteWebhook('wh-1');
    await client.getMessage('roomote@agentmail.to', 'm-1');
    await client.sendMessage('roomote@agentmail.to', { to: ['x@example.com'] });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://agentmail.test/v0/pods/pod_acme/inboxes',
      'POST https://agentmail.test/v0/pods/pod_acme/inboxes',
      'GET https://agentmail.test/v0/pods/pod_acme/inboxes/roomote%40agentmail.to',
      'PATCH https://agentmail.test/v0/pods/pod_acme/inboxes/roomote%40agentmail.to',
      'GET https://agentmail.test/v0/pods/pod_acme/webhooks',
      'POST https://agentmail.test/v0/pods/pod_acme/webhooks',
      'PATCH https://agentmail.test/v0/pods/pod_acme/webhooks/wh-1',
      'DELETE https://agentmail.test/v0/pods/pod_acme/webhooks/wh-1',
      'GET https://agentmail.test/v0/inboxes/roomote%40agentmail.to/messages/m-1',
      'POST https://agentmail.test/v0/inboxes/roomote%40agentmail.to/messages/send',
    ]);
    expect(client.podId).toBe('pod_acme');
  });

  it('stays at organization level without a pod', async () => {
    const { client, calls } = recordingClient();
    await client.listWebhooks();
    await client.createInbox({ username: 'roomote' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://agentmail.test/v0/webhooks',
      'https://agentmail.test/v0/inboxes',
    ]);
    expect(client.podId).toBeNull();
  });

  it("sends AgentMail's add/remove inbox lists and full event-type replacement on update", async () => {
    const { client, calls } = recordingClient();
    await client.updateWebhook('wh-1', {
      addInboxIds: ['new@agentmail.to'],
      removeInboxIds: ['old@agentmail.to'],
      eventTypes: ['message.received', 'message.bounced'],
    });
    await client.updateWebhook('wh-1', { eventTypes: [] });

    expect(calls[0]?.body).toEqual({
      add_inbox_ids: ['new@agentmail.to'],
      remove_inbox_ids: ['old@agentmail.to'],
      event_types: ['message.received', 'message.bounced'],
    });
    // An empty list must leave event types unchanged, never clear them.
    expect(calls[1]?.body).toEqual({});
  });
});
