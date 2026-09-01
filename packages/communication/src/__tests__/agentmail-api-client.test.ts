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
