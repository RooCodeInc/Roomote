import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import { WebClient } from '@slack/web-api';

import { MockSlackServer } from '../mock-slack-server';

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

describe('MockSlackServer', () => {
  it('stores posted messages and serves them back through conversations.replies', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        botUserId: 'BROOMOTE',
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
        messages: [
          {
            channel: 'C1',
            ts: '1710000000.000100',
            text: 'thread root',
            user: 'U1',
            type: 'message',
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: 'root' } },
            ],
            attachments: [{ text: 'root attachment' }],
          },
        ],
      },
    });

    try {
      await server.start();

      const postResponse = await fetch(
        `${server.baseUrl}/api/chat.postMessage`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer xoxb-mock-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            channel: 'C1',
            thread_ts: '1710000000.000100',
            text: 'agent reply',
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: 'reply' } },
            ],
            attachments: [{ text: 'reply attachment' }],
          }),
        },
      );

      expect(postResponse.status).toBe(200);

      const repliesResponse = await fetch(
        `${server.baseUrl}/api/conversations.replies?channel=C1&ts=1710000000.000100`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );
      const replies = (await repliesResponse.json()) as {
        ok: boolean;
        messages: Array<{
          text: string;
          user?: string;
          bot_id?: string;
          blocks?: unknown[];
          attachments?: unknown[];
        }>;
      };

      expect(replies.ok).toBe(true);
      expect(replies.messages.map((message) => message.text)).toEqual([
        'thread root',
        'agent reply',
      ]);
      expect(replies.messages[0]?.blocks).toEqual([
        { type: 'section', text: { type: 'mrkdwn', text: 'root' } },
      ]);
      expect(replies.messages[0]?.attachments).toEqual([
        { text: 'root attachment' },
      ]);
      // Bot-authored messages must mirror real Slack: `user` carries the
      // bot's user ID while `bot_id` comes from a separate `B…` ID space.
      expect(replies.messages[1]?.user).toBe('BROOMOTE');
      expect(replies.messages[1]?.bot_id).toBe('BMOCKAPP');
      expect(replies.messages[1]?.bot_id).not.toBe('BROOMOTE');
      expect(replies.messages[1]?.blocks).toEqual([
        { type: 'section', text: { type: 'mrkdwn', text: 'reply' } },
      ]);
      expect(replies.messages[1]?.attachments).toEqual([
        { text: 'reply attachment' },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('returns thread_not_found after the thread root is deleted', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        botUserId: 'BROOMOTE',
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
        messages: [
          {
            channel: 'C1',
            ts: '1710000000.000100',
            text: 'thread root',
            user: 'U1',
            type: 'message',
          },
          {
            channel: 'C1',
            ts: '1710000000.000200',
            thread_ts: '1710000000.000100',
            text: 'existing reply',
            user: 'BROOMOTE',
            bot_id: 'BROOMOTE',
            type: 'message',
          },
        ],
      },
    });

    try {
      await server.start();

      const deleteResponse = await fetch(`${server.baseUrl}/api/chat.delete`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer xoxb-mock-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          channel: 'C1',
          ts: '1710000000.000100',
        }),
      });

      expect(deleteResponse.status).toBe(200);

      const repliesResponse = await fetch(
        `${server.baseUrl}/api/conversations.replies?channel=C1&ts=1710000000.000100`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );

      await expect(repliesResponse.json()).resolves.toEqual({
        ok: false,
        error: 'thread_not_found',
      });
    } finally {
      await server.stop();
    }
  });

  it('signs and forwards replay events to the configured Roomote webhook target', async () => {
    const received: {
      body?: string;
      headers?: IncomingMessage['headers'];
    } = {};

    const webhookServer = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        received.body = await readBody(request);
        received.headers = request.headers;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      },
    );

    await new Promise<void>((resolve) => {
      webhookServer.listen(0, '127.0.0.1', () => resolve());
    });

    const webhookAddress = webhookServer.address() as AddressInfo;
    const signingSecret = 'mock-secret';

    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
      roomoteTarget: {
        webhookUrl: `http://127.0.0.1:${webhookAddress.port}/api/webhooks/slack`,
        signingSecret,
      },
    });

    try {
      const result = await server.dispatch({
        kind: 'event_callback',
        eventId: 'evt-1',
        event: {
          type: 'app_mention',
          channel: 'C1',
          user: 'U1',
          text: '<@UROOMOTE> investigate this',
          ts: '1710000000.000100',
        },
      });

      expect(result.status).toBe(200);
      expect(received.body).toContain('"event_id":"evt-1"');

      const timestamp = received.headers?.['x-slack-request-timestamp'];
      const signature = received.headers?.['x-slack-signature'];
      expect(typeof timestamp).toBe('string');
      expect(typeof signature).toBe('string');

      const expectedSignature = `v0=${createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${received.body ?? ''}`, 'utf8')
        .digest('hex')}`;

      expect(signature).toBe(expectedSignature);
      expect(
        server.getState().messages?.map((message) => message.text),
      ).toEqual(['<@UROOMOTE> investigate this']);
    } finally {
      await server.stop();
      await new Promise<void>((resolve, reject) => {
        webhookServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('accepts form-encoded Slack Web API requests from the real WebClient', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        botUserId: 'BROOMOTE',
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
        messages: [
          {
            channel: 'C1',
            ts: '1710000000.000100',
            text: 'thread root',
            user: 'U1',
            type: 'message',
          },
        ],
      },
    });

    try {
      await server.start();

      const client = new WebClient('xoxb-mock-token', {
        slackApiUrl: `${server.baseUrl}/api/`,
      });

      const postMessage = await client.chat.postMessage({
        channel: 'C1',
        thread_ts: '1710000000.000100',
        text: 'router debug reply',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Router:* Acme App' },
          },
        ],
      });

      expect(postMessage.ok).toBe(true);

      const unfurl = await client.chat.unfurl({
        channel: 'C1',
        ts: '1710000000.000100',
        unfurls: {
          'https://app.roomote.dev/task/123': {
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: 'Task unfurl' },
              },
            ],
          },
        },
      });

      expect(unfurl.ok).toBe(true);

      const entityDetails = await client.apiCall('entity.presentDetails', {
        external_id: 'task-123',
        views: [
          {
            type: 'modal',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: 'Task details' },
              },
            ],
          },
        ],
      });

      expect(entityDetails).toMatchObject({ ok: true });

      const repliesResponse = await fetch(
        `${server.baseUrl}/api/conversations.replies?channel=C1&ts=1710000000.000100`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );
      const replies = (await repliesResponse.json()) as {
        ok: boolean;
        messages: Array<{ text: string; blocks?: unknown[] }>;
      };

      expect(replies.ok).toBe(true);
      expect(replies.messages.map((message) => message.text)).toEqual([
        'thread root',
        'router debug reply',
      ]);

      expect(server.getState().messages?.[1]?.blocks).toEqual([
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Router:* Acme App' },
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('accepts any bearer token when acceptedBotTokens is empty', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: [],
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
    });

    try {
      await server.start();

      const response = await fetch(
        `${server.baseUrl}/api/conversations.list?types=public_channel`,
        {
          headers: {
            authorization: 'Bearer xoxb-any-token',
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        channels: [
          expect.objectContaining({
            id: 'C1',
            name: 'product-debug',
          }),
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it('accepts requests without an authorization header when acceptedBotTokens is omitted', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
    });

    try {
      await server.start();

      const response = await fetch(
        `${server.baseUrl}/api/conversations.list?types=public_channel`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        channels: [
          expect.objectContaining({
            id: 'C1',
            name: 'product-debug',
          }),
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it('returns channel members with Slack-style pagination', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        channels: [
          {
            id: 'C123ABC456',
            name: 'product-debug',
            isMember: true,
            members: ['UGRACE', 'UROOMOTE'],
          },
        ],
        users: [
          { id: 'UGRACE', name: 'grace', displayName: 'Grace Hopper' },
          { id: 'UROOMOTE', name: 'roomote', displayName: 'Roomote' },
        ],
      },
    });

    try {
      await server.start();

      const firstPageResponse = await fetch(
        `${server.baseUrl}/api/conversations.members?channel=C123ABC456&limit=1`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );

      expect(firstPageResponse.status).toBe(200);
      await expect(firstPageResponse.json()).resolves.toEqual({
        ok: true,
        members: ['UGRACE'],
        response_metadata: { next_cursor: '1' },
      });

      const secondPageResponse = await fetch(
        `${server.baseUrl}/api/conversations.members?channel=C123ABC456&limit=1&cursor=1`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );

      expect(secondPageResponse.status).toBe(200);
      await expect(secondPageResponse.json()).resolves.toEqual({
        ok: true,
        members: ['UROOMOTE'],
        response_metadata: { next_cursor: '' },
      });
    } finally {
      await server.stop();
    }
  });

  it('creates an app through apps.manifest.create with a config token and records the manifest', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        acceptedConfigTokens: ['xoxe.xoxp-config-token'],
        manifestCredentials: {
          appId: 'A0MANIFEST',
          clientId: 'manifest-client-id',
          clientSecret: 'manifest-client-secret',
          signingSecret: 'manifest-signing-secret',
        },
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
    });

    try {
      await server.start();

      const manifest = {
        display_information: { name: 'Roomote' },
        settings: {
          event_subscriptions: {
            request_url: 'https://roomote.example.com/api/webhooks/slack',
          },
        },
      };

      // Config-token routes must not require a bot token: the config token
      // is the only credential on this request.
      const response = await fetch(
        `${server.baseUrl}/api/apps.manifest.create`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer xoxe.xoxp-config-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        app_id: 'A0MANIFEST',
        credentials: {
          client_id: 'manifest-client-id',
          client_secret: 'manifest-client-secret',
          verification_token: 'mock-manifest-verification-token',
          signing_secret: 'manifest-signing-secret',
        },
        oauth_authorize_url:
          'https://slack.com/oauth/v2/authorize?client_id=manifest-client-id',
      });

      expect(server.getState().createdManifests).toEqual([
        { appId: 'A0MANIFEST', manifest },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('rejects apps.manifest.create with invalid_auth for an unknown config token', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedConfigTokens: ['xoxe.xoxp-config-token'],
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
    });

    try {
      await server.start();

      const response = await fetch(
        `${server.baseUrl}/api/apps.manifest.create`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer xoxe.xoxp-wrong-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ manifest: '{}' }),
        },
      );

      // Real Slack reports Web API failures as HTTP 200 with ok=false.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'invalid_auth',
      });
      expect(server.getState().createdManifests ?? []).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('rejects apps.manifest.create with invalid_manifest when the manifest is not JSON', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        channels: [{ id: 'C1', name: 'product-debug', isMember: true }],
        users: [{ id: 'U1', name: 'alex', displayName: 'Alex' }],
      },
    });

    try {
      await server.start();

      const response = await fetch(
        `${server.baseUrl}/api/apps.manifest.create`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer xoxe.xoxp-any-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ manifest: 'not-json' }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'invalid_manifest',
        errors: [
          { message: 'manifest must be a JSON object', pointer: '/manifest' },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it('returns not_in_channel for conversations.members when the app is not in the channel', async () => {
    const server = new MockSlackServer({
      state: {
        team: { id: 'T1', domain: 'mock-roomote' },
        acceptedBotTokens: ['xoxb-mock-token'],
        channels: [
          {
            id: 'C123ABC456',
            name: 'product-debug',
            isMember: false,
            members: ['UGRACE', 'UROOMOTE'],
          },
        ],
        users: [
          { id: 'UGRACE', name: 'grace', displayName: 'Grace Hopper' },
          { id: 'UROOMOTE', name: 'roomote', displayName: 'Roomote' },
        ],
      },
    });

    try {
      await server.start();

      const response = await fetch(
        `${server.baseUrl}/api/conversations.members?channel=C123ABC456&limit=1`,
        {
          headers: {
            authorization: 'Bearer xoxb-mock-token',
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: 'not_in_channel',
      });
    } finally {
      await server.stop();
    }
  });
});
