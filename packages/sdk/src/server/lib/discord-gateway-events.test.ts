import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, queueMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  queueMock: vi.fn().mockImplementation(function () {
    return { add: addMock, getJob: getJobMock };
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
    getJobMock.mockResolvedValue(undefined);
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
          attempts: 9,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
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

  it('retains exhausted failed jobs for dead-letter inspection', async () => {
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
        defaultJobOptions: expect.objectContaining({
          removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
        }),
      }),
    );
  });

  it('creates a new generation when the deterministic job is retained as failed', async () => {
    getJobMock
      .mockResolvedValueOnce({ getState: vi.fn().mockResolvedValue('failed') })
      .mockResolvedValueOnce(undefined);
    const event = {
      eventId: 'message-3',
      eventType: 'MESSAGE_CREATE' as const,
      payload: {
        id: 'message-3',
        channel_id: 'channel-1',
        content: 'hello',
        author: { id: 'user-1', username: 'user' },
        mentions: [],
        attachments: [],
      },
      receivedAt: '2026-07-24T00:00:00.000Z',
    };

    await expect(enqueueDiscordGatewayEvent(event)).resolves.toEqual({
      jobId: 'discord-gateway-event-MESSAGE_CREATE-message-3-redelivery-1',
    });
    expect(addMock).toHaveBeenCalledWith(
      'process-discord-gateway-event',
      event,
      {
        jobId: 'discord-gateway-event-MESSAGE_CREATE-message-3-redelivery-1',
      },
    );
  });
});
