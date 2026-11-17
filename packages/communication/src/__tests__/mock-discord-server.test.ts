import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { DiscordCommunicationProvider } from '../discord-provider';
import { MockDiscordServer } from '../mock-discord-server';

const channelId = '400000000000000001';

describe('MockDiscordServer HTTP request recovery', () => {
  it('keeps REST state and serves valid requests after malformed JSON', async () => {
    const mock = new MockDiscordServer();
    const { baseUrl, close } = await mock.listen();
    const provider = new DiscordCommunicationProvider({
      botToken: mock.botToken,
      applicationId: mock.application.id,
      apiBaseUrl: baseUrl,
    });
    try {
      const first = await provider.postMessage({
        channelId,
        text: 'Before failure',
      });
      const failure = await fetch(`${baseUrl}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${mock.botToken}`,
        },
        body: '{',
      });
      expect(failure.status).toBe(500);
      expect(await failure.json()).toMatchObject({
        message: expect.any(String),
      });

      const second = await provider.postMessage({
        channelId,
        text: 'After failure',
      });
      const state = await (await fetch(new URL('/mock/state', baseUrl))).json();
      expect(
        state.messages[channelId].map((message: { id: string }) => message.id),
      ).toEqual([first.messageId, second.messageId]);
    } finally {
      await close();
    }
  });

  it('retains a failed Gateway replay and retries the same event after the target recovers', async () => {
    let disconnect = true;
    const received: { body: string; secret: string | string[] | undefined }[] =
      [];
    const target = createServer(async (request, response) => {
      if (disconnect) {
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        body: Buffer.concat(chunks).toString(),
        secret: request.headers['x-roomote-discord-gateway-secret'],
      });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, queued: true }));
    });
    await new Promise<void>((resolve) =>
      target.listen(0, '127.0.0.1', resolve),
    );
    const address = target.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test target address');
    const mock = new MockDiscordServer({
      roomoteTarget: {
        eventsUrl: `http://127.0.0.1:${address.port}/api/internal/discord/events`,
        gatewaySecret: 'disposable-test-secret',
      },
    });
    const { baseUrl, close } = await mock.listen();
    const event = {
      kind: 'message',
      payload: {
        id: '600000000000000001',
        channel_id: channelId,
        content: 'Replay this once the target is available',
        author: { id: '111000111000111001', username: 'fixture' },
        attachments: [],
      },
    };
    const replay = () =>
      fetch(new URL('/mock/events', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
    try {
      const failed = await replay();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ message: 'fetch failed' });
      expect(mock.state.messages[channelId]).toHaveLength(1);
      disconnect = false;
      const recovered = await replay();
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        dispatchResult: { status: 202 },
      });
      expect(mock.state.messages[channelId]).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received[0]?.secret).toBe('disposable-test-secret');
      expect(JSON.parse(received[0]!.body)).toMatchObject({
        eventId: event.payload.id,
        eventType: 'MESSAGE_CREATE',
        payload: event.payload,
      });
    } finally {
      await close();
      await new Promise<void>((resolve, reject) =>
        target.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
