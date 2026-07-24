import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, queueMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  queueMock: vi.fn().mockImplementation(function () {
    return { add: addMock };
  }),
}));

vi.mock('bullmq', () => ({
  Queue: queueMock,
}));

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));

import {
  DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
  enqueueDiscordGatewayEvent,
} from './discord-gateway-events';

describe('enqueueDiscordGatewayEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMock.mockResolvedValue({ id: 'event-message-1' });
  });

  it('persists a validated event with a deterministic id and retry policy', async () => {
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

    await expect(enqueueDiscordGatewayEvent(event)).resolves.toEqual({
      jobId: 'discord-gateway-event-MESSAGE_CREATE-message-1',
    });
    expect(DISCORD_GATEWAY_EVENTS_QUEUE_NAME).toBe('discord-gateway-events');
    expect(queueMock).toHaveBeenCalledWith(
      DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
        }),
      }),
    );
    expect(addMock).toHaveBeenCalledWith(
      'process-discord-gateway-event',
      event,
      {
        jobId: 'discord-gateway-event-MESSAGE_CREATE-message-1',
      },
    );
  });

  it('removes exhausted failed jobs so Discord can enqueue a retry', async () => {
    vi.resetModules();
    const { enqueueDiscordGatewayEvent: enqueueEvent } =
      await import('./discord-gateway-events');

    await enqueueEvent({
      eventId: 'message-2',
      eventType: 'MESSAGE_CREATE',
      payload: {
        id: 'message-2',
        channel_id: 'channel-1',
        content: 'hello',
        author: { id: 'user-1', username: 'user' },
        mentions: [],
        attachments: [],
      },
      receivedAt: '2026-07-24T00:00:00.000Z',
    });

    expect(queueMock).toHaveBeenCalledWith(
      'discord-gateway-events',
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({ removeOnFail: true }),
      }),
    );
  });
});
