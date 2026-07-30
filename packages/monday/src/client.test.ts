import { MondayClient, MONDAY_AGENTS_API_VERSION } from './client';
import { describe, expect, it, vi } from 'vitest';

describe('MondayClient', () => {
  it('connects an inactive custom external agent with the dev API', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            connect_external_agent_sync: {
              agent_id: 'agent-1',
              api_token: 'agent-token',
              signing_secret: 'signing-secret',
              instructions: 'Keep this secure',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new MondayClient({ token: 'owner-token', fetch: fetchMock });

    await expect(
      client.connectExternalAgent({
        name: 'Roomote',
        callbackUrl: 'https://roomote.example/api/webhooks/monday/agent',
      }),
    ).resolves.toEqual({
      agentId: 'agent-1',
      apiToken: 'agent-token',
      signingSecret: 'signing-secret',
      instructions: 'Keep this secure',
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.headers).toMatchObject({
      Authorization: 'owner-token',
      'API-Version': MONDAY_AGENTS_API_VERSION,
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      variables: {
        input: {
          custom: {
            name: 'Roomote',
            callback_url: 'https://roomote.example/api/webhooks/monday/agent',
          },
        },
      },
    });
  });

  it('surfaces GraphQL errors without exposing the token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errors: [{ message: 'Agent access unavailable' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = new MondayClient({
      token: 'never-log-me',
      fetch: fetchMock,
    });

    await expect(client.getAccount()).rejects.toThrow(
      'Agent access unavailable',
    );
    await expect(client.getAccount()).rejects.not.toThrow('never-log-me');
  });
});
