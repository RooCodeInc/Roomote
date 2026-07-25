import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, fetchMock, resolveSecretMock } = vi.hoisted(() => ({
  envMock: { TRPC_URL: 'http://api:13001' as string | undefined },
  fetchMock: vi.fn(),
  resolveSecretMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));

vi.mock('@roomote/db/server', () => ({
  resolveDiscordGatewaySecret: resolveSecretMock,
}));

vi.mock('@roomote/sdk/server', () => ({
  DISCORD_GATEWAY_EVENTS_QUEUE_NAME: 'discord-gateway-events',
}));

import { processDiscordGatewayEventJob } from './discord-gateway-events-queue';

const event = {
  eventId: 'message-1',
  eventType: 'MESSAGE_CREATE' as const,
  payload: {
    id: 'message-1',
    channel_id: 'channel-1',
    content: 'hello',
    author: { id: 'user-1', username: 'user' },
    mentions: [],
    attachments: [],
  },
  receivedAt: '2026-07-24T00:00:00.000Z',
};

describe('processDiscordGatewayEventJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.TRPC_URL = 'http://api:13001';
    vi.stubGlobal('fetch', fetchMock);
    resolveSecretMock.mockResolvedValue('gateway-secret');
  });

  it('posts the event to the internal processing endpoint with gateway auth', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await processDiscordGatewayEventJob({ data: event } as Job<typeof event>);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api:13001/api/internal/discord/events/process',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-roomote-discord-gateway-secret': 'gateway-secret',
        },
        body: JSON.stringify(event),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('treats an already completed event as successful', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 409 }));

    await expect(
      processDiscordGatewayEventJob({ data: event } as Job<typeof event>),
    ).resolves.toBeUndefined();
  });

  it('throws retryable processing failures for BullMQ', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      processDiscordGatewayEventJob({ data: event } as Job<typeof event>),
    ).rejects.toThrow('HTTP 503');
  });

  it('throws 425 processing responses so BullMQ retries the event', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 425 }));

    await expect(
      processDiscordGatewayEventJob({ data: event } as Job<typeof event>),
    ).rejects.toThrow('HTTP 425');
  });

  it('fails fast when the worker API URL is missing', async () => {
    envMock.TRPC_URL = undefined;

    await expect(
      processDiscordGatewayEventJob({ data: event } as Job<typeof event>),
    ).rejects.toThrow('TRPC_URL is required to process Discord gateway events');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
