import { Queue, Worker, type Job } from 'bullmq';

import { resolveDiscordGatewaySecret } from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';
import { DISCORD_GATEWAY_EVENTS_QUEUE_NAME } from '@roomote/sdk/server';

import { getRedis } from './redis';

const DISCORD_GATEWAY_SECRET_HEADER = 'x-roomote-discord-gateway-secret';

function processUrl(): string {
  return new URL(
    '/api/internal/discord/events/process',
    Env.TRPC_URL ?? 'http://127.0.0.1:13001',
  ).toString();
}

export async function processDiscordGatewayEventJob(
  job: Job<DiscordGatewayEvent>,
): Promise<void> {
  const secret = await resolveDiscordGatewaySecret();
  if (!secret) {
    throw new Error('Discord Gateway secret is not configured');
  }

  const response = await fetch(processUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [DISCORD_GATEWAY_SECRET_HEADER]: secret,
    },
    body: JSON.stringify(job.data),
  });

  // A completed event can outlive its retained BullMQ job. The API's durable
  // idempotency gate reports that state as a conflict, which is successful work.
  if (response.ok || response.status === 409) return;

  throw new Error(
    `Discord event processing failed with HTTP ${response.status}`,
  );
}

export function startDiscordGatewayEventsQueue() {
  const connection = getRedis();
  const queue = new Queue<DiscordGatewayEvent>(
    DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
    {
      connection,
    },
  );
  const worker = new Worker<DiscordGatewayEvent>(
    DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
    processDiscordGatewayEventJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[DiscordGatewayEventsQueue] job ${job?.id} failed for ${job?.data.eventId}: ${error.message}`,
    ),
  );
  worker.on('error', (error) =>
    console.error('[DiscordGatewayEventsQueue] worker error:', error),
  );

  return { queue, worker };
}
