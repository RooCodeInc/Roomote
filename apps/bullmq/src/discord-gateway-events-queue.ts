import { Queue, Worker, type Job } from 'bullmq';

import { resolveDiscordGatewaySecret } from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';
import { DISCORD_GATEWAY_EVENTS_QUEUE_NAME } from '@roomote/sdk/server';

import { getRedis } from './redis';

const DISCORD_GATEWAY_SECRET_HEADER = 'x-roomote-discord-gateway-secret';
const DISCORD_GATEWAY_EVENT_WORKER_TIMEOUT_MS = 4 * 60 * 1000 + 15_000;

function processUrl(): string {
  if (!Env.TRPC_URL) {
    throw new Error('TRPC_URL is required to process Discord gateway events');
  }

  return new URL(
    '/api/internal/discord/events/process',
    Env.TRPC_URL,
  ).toString();
}

export async function processDiscordGatewayEventJob(
  job: Job<DiscordGatewayEvent>,
): Promise<void> {
  const url = processUrl();
  const secret = await resolveDiscordGatewaySecret();
  if (!secret) {
    throw new Error('Discord Gateway secret is not configured');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [DISCORD_GATEWAY_SECRET_HEADER]: secret,
    },
    body: JSON.stringify(job.data),
    // Let the API release its lease and return its retryable timeout first.
    signal: AbortSignal.timeout(DISCORD_GATEWAY_EVENT_WORKER_TIMEOUT_MS),
  });

  // A completed event can outlive its retained BullMQ job. The API's durable
  // idempotency gate reports that state as a conflict, which is successful work.
  if (response.ok || response.status === 409) return;

  throw new Error(
    `Discord event processing failed with HTTP ${response.status}`,
  );
}

export function startDiscordGatewayEventsQueue(): {
  queue: Queue<DiscordGatewayEvent>;
  worker: Worker<DiscordGatewayEvent>;
} {
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
