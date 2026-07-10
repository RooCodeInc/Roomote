import { describe, expect, it, vi } from 'vitest';

import { UnsupportedCommunicationOperationError } from '../provider';
import { exchangeMicrosoftDelegatedGraphToken } from '../teams-graph-client';
import {
  TeamsCommunicationProvider,
  createTeamsCommunicationProviderFromEnv,
} from '../teams-provider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function binaryResponse(body: ArrayBuffer, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
    },
  });
}

describe('TeamsCommunicationProvider', () => {
  it('sends Teams messages through the Bot Framework connector API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'activity-response' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '19:conversation@thread.v2',
        threadId: 'activity-root',
        text: 'hello from Roomote',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: '19:conversation@thread.v2',
      messageId: 'activity-response',
      threadId: 'activity-root',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://login.example.test/token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Aconversation%40thread.v2/activities/activity-root',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          type: 'message',
          text: 'hello from Roomote',
        }),
      }),
    );

    const tokenBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(tokenBody).toBeInstanceOf(URLSearchParams);
    expect((tokenBody as URLSearchParams).get('grant_type')).toBe(
      'client_credentials',
    );
    expect((tokenBody as URLSearchParams).get('client_id')).toBe('bot-app-id');
    expect((tokenBody as URLSearchParams).get('scope')).toBe(
      'https://api.botframework.com/.default',
    );
  });

  it('requires a serviceUrl for outbound Teams messages', async () => {
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.postMessage({
        channelId: '19:conversation@thread.v2',
        text: 'hello',
      }),
    ).rejects.toThrow('Teams postMessage requires a Bot Framework serviceUrl');
  });

  it('sends images as Bot Framework attachments', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'activity-response' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await provider.postMessage({
      channelId: '19:conversation@thread.v2',
      text: 'Here is the screenshot',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
          altText: 'screenshot.png',
          contentType: 'image/png',
        },
      ],
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Aconversation%40thread.v2/activities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'message',
          text: 'Here is the screenshot',
          attachments: [
            {
              contentType: 'image/png',
              contentUrl:
                'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
              name: 'screenshot.png',
            },
          ],
        }),
      }),
    );
  });

  it('sends direct Teams messages through a one-on-one Bot Framework conversation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'a:direct-conversation' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'direct-activity' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.postDirectMessage({
        botName: 'Roomote',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        tenantId: 'tenant-1',
        text: 'link your account',
        textFormat: 'markdown',
        userId: '29:user',
      }),
    ).resolves.toEqual({
      provider: 'teams',
      channelId: 'a:direct-conversation',
      messageId: 'direct-activity',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          bot: {
            id: 'bot-app-id',
            name: 'Roomote',
          },
          members: [{ id: '29:user' }],
          channelData: {
            tenant: {
              id: 'tenant-1',
            },
          },
          tenantId: 'tenant-1',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://smba.trafficmanager.net/amer/v3/conversations/a%3Adirect-conversation/activities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'message',
          text: 'link your account',
          textFormat: 'markdown',
        }),
      }),
    );
  });

  it('updates existing Teams messages through the Bot Framework connector API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'activity-updated' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.updateMessage({
        channelId: '19:conversation@thread.v2',
        messageId: 'activity-root',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        text: 'rewritten without footer',
        textFormat: 'markdown',
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Aconversation%40thread.v2/activities/activity-root',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          type: 'message',
          text: 'rewritten without footer',
          textFormat: 'markdown',
        }),
      }),
    );
  });

  it('re-attaches images when updateMessage is used to clear a footer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'activity-updated' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await provider.updateMessage({
      channelId: '19:conversation@thread.v2',
      messageId: 'activity-root',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      text: 'done with screenshot',
      textFormat: 'markdown',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
          altText: 'screenshot.png',
          contentType: 'image/png',
        },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Aconversation%40thread.v2/activities/activity-root',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          type: 'message',
          text: 'done with screenshot',
          textFormat: 'markdown',
          attachments: [
            {
              contentType: 'image/png',
              contentUrl:
                'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
              name: 'screenshot.png',
            },
          ],
        }),
      }),
    );
  });

  it('downloads Teams image attachments with Bot Framework auth and converts them to prompt images', async () => {
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const imageArrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(
        binaryResponse(imageArrayBuffer, 'application/octet-stream'),
      );
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.processImageAttachments([
        {
          contentType: 'image/jpeg',
          contentUrl:
            'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
          name: 'screenshot.png',
        },
      ]),
    ).resolves.toEqual([
      `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`,
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
        }),
      }),
    );
  });

  it('does not send the Bot Framework token to untrusted attachment hosts', async () => {
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const imageArrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        binaryResponse(imageArrayBuffer, 'application/octet-stream'),
      );
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await provider.processImageAttachments(
      [
        {
          contentType: 'image/png',
          contentUrl: 'https://evil.example.test/screenshot.png',
        },
      ],
      { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://evil.example.test/screenshot.png',
      expect.objectContaining({
        method: 'GET',
        headers: expect.not.objectContaining({
          authorization: expect.any(String),
        }),
      }),
    );
  });

  it('rejects Teams image attachments that exceed the size cap', async () => {
    const overlargeBytes = Buffer.alloc(11 * 1024 * 1024, 0x42);
    const overlargeArrayBuffer = overlargeBytes.buffer.slice(
      overlargeBytes.byteOffset,
      overlargeBytes.byteOffset + overlargeBytes.byteLength,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(
        binaryResponse(overlargeArrayBuffer, 'application/octet-stream'),
      );
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      provider.processImageAttachments(
        [
          {
            contentType: 'image/png',
            contentUrl:
              'https://smba.trafficmanager.net/amer/v3/attachments/att-1/views/original',
          },
        ],
        { serviceUrl: 'https://smba.trafficmanager.net/amer/' },
      ),
    ).resolves.toEqual([]);
  });

  it('caps the number of Teams image attachments processed', async () => {
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const imageArrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    );
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'bot-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
    for (let i = 0; i < 12; i += 1) {
      fetchMock.mockResolvedValueOnce(
        binaryResponse(imageArrayBuffer, 'image/png'),
      );
    }
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    const attachments = Array.from({ length: 12 }, (_, index) => ({
      contentType: 'image/png',
      contentUrl: `https://smba.trafficmanager.net/amer/v3/attachments/att-${index}/views/original`,
    }));

    const images = await provider.processImageAttachments(attachments, {
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    expect(images).toHaveLength(10);
  });

  it('downloads Teams hosted content images for channel replies through Graph', async () => {
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const imageArrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ aadGroupId: 'team-group-id' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'reply-1',
          from: { user: { displayName: 'Ada Lovelace' } },
          body: {
            contentType: 'html',
            content:
              '<div><img src="../hostedContents/hosted-1/$value" alt="screenshot.png"></div>',
          },
          attachments: [],
        }),
      )
      .mockResolvedValueOnce(binaryResponse(imageArrayBuffer, 'image/png'));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
      graphTokenProvider: async () => 'graph-token',
    });

    await expect(
      provider.fetchMessageImageDataUrls({
        channelId: '19:channel@thread.tacv2',
        messageId: 'reply-1',
        threadId: 'root-1',
        teamId: 'team-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    ).resolves.toEqual([
      `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`,
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://graph.microsoft.com/v1.0/teams/team-group-id/channels/19%3Achannel%40thread.tacv2/messages/root-1/replies/reply-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer graph-token',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://graph.microsoft.com/v1.0/teams/team-group-id/channels/19%3Achannel%40thread.tacv2/messages/root-1/replies/reply-1/hostedContents/hosted-1/$value',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer graph-token',
        }),
      }),
    );
  });

  it('reports Teams history reads as unsupported when Graph is not configured', async () => {
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.fetchThreadMessages({
        channelId: '19:conversation@thread.v2',
        messageId: 'activity-root',
      }),
    ).rejects.toMatchObject({
      code: 'communication_operation_unsupported',
      provider: 'teams',
      operation: 'fetchThreadMessages',
      help: expect.stringContaining('delegated Graph permissions'),
    });
    await expect(
      provider.fetchThreadMessages({
        channelId: '19:conversation@thread.v2',
        messageId: 'activity-root',
      }),
    ).rejects.toBeInstanceOf(UnsupportedCommunicationOperationError);

    await expect(
      provider.fetchChannelMessages({
        channelId: '19:conversation@thread.v2',
      }),
    ).rejects.toMatchObject({
      code: 'communication_operation_unsupported',
      provider: 'teams',
      operation: 'fetchChannelMessages',
      help: expect.stringContaining('delegated Graph permissions'),
    });
  });

  it('fetches channel thread history through Microsoft Graph', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('/oauth2/v2.0/token') || url.includes('login.example')) {
        return jsonResponse({
          access_token: 'token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }

      if (url.includes('/v3/teams/')) {
        return jsonResponse({ id: '19:team', aadGroupId: 'group-1' });
      }

      if (url.includes('/replies')) {
        return jsonResponse({
          value: [
            {
              id: '200',
              from: { user: { displayName: 'Reply Author' } },
              body: { contentType: 'html', content: '<p>Second&nbsp;msg</p>' },
              createdDateTime: '2026-07-03T11:00:00Z',
            },
          ],
        });
      }

      if (url.includes('/messages/100')) {
        return jsonResponse({
          id: '100',
          from: { user: { displayName: 'Root Author' } },
          body: { contentType: 'text', content: 'thread root' },
          createdDateTime: '2026-07-03T10:00:00Z',
          attachments: [{ id: 'file-1' }],
        });
      }

      return jsonResponse({ error: `unexpected ${url}` }, 404);
    });
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      graphTokenProvider: async () => 'delegated-graph-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.fetchThreadMessages({
      channelId: '19:abc@thread.tacv2;messageid=100',
      messageId: '100',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      teamId: '19:team',
    });

    expect(result).toMatchObject({
      provider: 'teams',
      channelId: '19:abc@thread.tacv2;messageid=100',
      requestedMessageId: '100',
      threadId: '100',
      matchedMessageIndex: 0,
      messageCount: 2,
    });
    expect(result.messages).toEqual([
      {
        provider: 'teams',
        id: '100',
        user: 'Root Author',
        text: 'thread root',
        channelId: '19:abc@thread.tacv2;messageid=100',
        threadId: '100',
        fileCount: 1,
      },
      {
        provider: 'teams',
        id: '200',
        user: 'Reply Author',
        text: 'Second msg',
        channelId: '19:abc@thread.tacv2;messageid=100',
        threadId: '100',
        fileCount: 0,
      },
    ]);
  });

  it('exposes author identity and mentions on raw Graph thread messages', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('/oauth2/v2.0/token') || url.includes('login.example')) {
        return jsonResponse({
          access_token: 'token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }

      if (url.includes('/v3/teams/')) {
        return jsonResponse({ id: '19:team', aadGroupId: 'group-1' });
      }

      if (url.includes('/replies')) {
        return jsonResponse({
          value: [
            {
              id: '200',
              from: {
                application: { id: 'bot-app-id', displayName: 'Roomote' },
              },
              body: { contentType: 'text', content: 'on it' },
              createdDateTime: '2026-07-03T11:00:00Z',
            },
            {
              id: '300',
              from: {
                user: { id: 'aad-user-2', displayName: 'Grace Hopper' },
              },
              body: {
                contentType: 'html',
                content: '<p><at id="0">Roomote</at> keep going</p>',
              },
              mentions: [
                {
                  id: 0,
                  mentionText: 'Roomote',
                  mentioned: {
                    application: { id: 'bot-app-id', displayName: 'Roomote' },
                  },
                },
                {
                  id: 1,
                  mentionText: 'Ada',
                  mentioned: {
                    user: { id: 'aad-user-1', displayName: 'Ada Lovelace' },
                  },
                },
              ],
              createdDateTime: '2026-07-03T12:00:00Z',
            },
          ],
        });
      }

      if (url.includes('/messages/100')) {
        return jsonResponse({
          id: '100',
          from: { user: { id: 'aad-user-1', displayName: 'Ada Lovelace' } },
          body: { contentType: 'text', content: 'thread root' },
          createdDateTime: '2026-07-03T10:00:00Z',
        });
      }

      return jsonResponse({ error: `unexpected ${url}` }, 404);
    });
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      graphTokenProvider: async () => 'delegated-graph-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.fetchThreadGraphMessages({
      channelId: '19:abc@thread.tacv2;messageid=100',
      messageId: '100',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      teamId: '19:team',
    });

    expect(result.threadId).toBe('100');
    expect(result.messages).toEqual([
      expect.objectContaining({
        id: '100',
        author: 'Ada Lovelace',
        authorUserId: 'aad-user-1',
        mentions: [],
      }),
      expect.objectContaining({
        id: '200',
        author: 'Roomote',
        authorApplicationId: 'bot-app-id',
        mentions: [],
      }),
      expect.objectContaining({
        id: '300',
        author: 'Grace Hopper',
        authorUserId: 'aad-user-2',
        mentions: [
          { applicationId: 'bot-app-id', name: 'Roomote' },
          { userId: 'aad-user-1', name: 'Ada' },
        ],
      }),
    ]);
    expect(result.messages[0]).not.toHaveProperty('authorApplicationId');
    expect(result.messages[1]).not.toHaveProperty('authorUserId');
  });

  it('fetches group chat history through the Graph chats endpoint with paging', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({
          access_token: 'token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }

      if (url.includes('skiptoken=page2')) {
        return jsonResponse({
          value: [
            {
              id: '1',
              from: { user: { displayName: 'Earlier' } },
              body: { contentType: 'text', content: 'first' },
              createdDateTime: '2026-07-03T10:00:00Z',
            },
          ],
        });
      }

      if (url.includes('/chats/')) {
        return jsonResponse({
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/chats/19%3Agroupchat%40thread.v2/messages?$skiptoken=page2',
          value: [
            {
              id: '2',
              from: { user: { displayName: 'Later' } },
              body: { contentType: 'text', content: 'second' },
              createdDateTime: '2026-07-03T11:00:00Z',
            },
          ],
        });
      }

      return jsonResponse({ error: `unexpected ${url}` }, 404);
    });
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      graphTokenProvider: async () => 'delegated-graph-token',
      fetch: fetchMock as unknown as typeof fetch,
    });

    // Group chats share the `19:...@thread.v2` id format with channels; the
    // absence of a Bot Framework teamId selects the chats endpoint.
    const result = await provider.fetchChannelMessages({
      channelId: '19:groupchat@thread.v2',
      oldest: '2026-07-03T09:00:00Z',
    });

    expect(result.messageCount).toBe(2);
    expect(result.messages.map((message) => message.text)).toEqual([
      'first',
      'second',
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/v3/teams/')),
    ).toBe(false);
  });

  it('adds channel thread reactions as emoji-only Bot Framework replies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'emoji-activity' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.addReaction({
      channelId: '19:abc@thread.tacv2;messageid=100',
      messageId: '200',
      name: 'eyes',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      threadId: '100',
    });

    expect(result).toEqual({
      provider: 'teams',
      channelId: '19:abc@thread.tacv2;messageid=100',
      messageId: '200',
      name: 'eyes',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D100/activities/100',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          type: 'message',
          text: '👀',
          textFormat: 'plain',
        }),
      }),
    );
  });

  it('maps named Teams reactions to emoji-only messages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'bot-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'emoji-activity' }));
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      tokenEndpoint: 'https://login.example.test/token',
      fetch: fetchMock as typeof fetch,
    });

    await provider.addReaction({
      channelId: '19:groupchat@thread.v2',
      messageId: '77',
      name: 'thumbsup',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Agroupchat%40thread.v2/activities/77',
      expect.objectContaining({
        body: JSON.stringify({
          type: 'message',
          text: '👍',
          textFormat: 'plain',
        }),
      }),
    );
  });

  it('requires serviceUrl for Teams reaction messages', async () => {
    const provider = new TeamsCommunicationProvider({
      appId: 'bot-app-id',
      appPassword: 'bot-secret',
      fetch: vi.fn() as typeof fetch,
    });

    await expect(
      provider.addReaction({
        channelId: '19:groupchat@thread.v2',
        messageId: '77',
        name: 'eyes',
      }),
    ).rejects.toMatchObject({
      code: 'communication_operation_unsupported',
      provider: 'teams',
      operation: 'addReaction',
      message:
        'Teams emoji reaction messages require a Bot Framework serviceUrl.',
    });
  });
});

describe('exchangeMicrosoftDelegatedGraphToken', () => {
  it('exchanges a refresh token for a delegated Graph access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        access_token: 'graph-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 1800,
        token_type: 'Bearer',
      }),
    );

    await expect(
      exchangeMicrosoftDelegatedGraphToken({
        clientId: 'auth-client-id',
        clientSecret: 'auth-client-secret',
        tenantId: 'tenant-1',
        refreshToken: 'stored-refresh-token',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      accessToken: 'graph-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresInSeconds: 1800,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-refresh-token');
    expect(body.get('scope')).toContain(
      'https://graph.microsoft.com/ChannelMessage.Read.All',
    );
  });

  it('throws on token exchange failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(
      exchangeMicrosoftDelegatedGraphToken({
        clientId: 'auth-client-id',
        clientSecret: 'auth-client-secret',
        tenantId: 'tenant-1',
        refreshToken: 'expired-refresh-token',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Microsoft delegated Graph token exchange failed');
  });
});

describe('createTeamsCommunicationProviderFromEnv', () => {
  it('returns null when bot credentials are not configured', () => {
    expect(createTeamsCommunicationProviderFromEnv({})).toBeNull();
    expect(
      createTeamsCommunicationProviderFromEnv({
        R_TEAMS_BOT_APP_ID: 'bot-app-id',
      }),
    ).toBeNull();
    expect(
      createTeamsCommunicationProviderFromEnv({
        R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
      }),
    ).toBeNull();
  });

  it('builds a provider when the required bot credentials are configured', () => {
    expect(
      createTeamsCommunicationProviderFromEnv({
        R_TEAMS_BOT_APP_ID: 'bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'bot-secret',
        R_TEAMS_BOT_TENANT_ID: 'tenant-id',
        R_TEAMS_BOT_TOKEN_ENDPOINT: 'https://login.example.test/token',
        R_TEAMS_BOT_OAUTH_SCOPE: 'https://api.botframework.com/.default',
      }),
    ).toBeInstanceOf(TeamsCommunicationProvider);
  });
});
