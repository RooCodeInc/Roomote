import { Queue, Worker, type Job } from 'bullmq';

import { resolveDiscordGatewaySecret } from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';
import { DISCORD_GATEWAY_EVENTS_QUEUE_NAME } from '@roomote/sdk/server';
import { resolveApiUrl } from '@roomote/types';

import { getRedis } from './redis';

const DISCORD_GATEWAY_SECRET_HEADER = 'x-roomote-discord-gateway-secret';
const DISCORD_GATEWAY_EVENT_WORKER_TIMEOUT_MS = 4 * 60 * 1000 + 15_000;

function processUrl(): string {
  if (!Env.TRPC_URL) {
    throw new Error('TRPC_URL is required to process Discord gateway events');
  }

  // TRPC_URL may carry a path prefix — the self-hosted installer default is
  // `https://<domain>/_roomote-api`, which the edge strips before proxying to
  // the API. The endpoint has to be appended to that prefix, not resolved
  // against it, or the request misses the API route entirely.
  return resolveApiUrl(Env.TRPC_URL, '/api/internal/discord/events/process');
}

// A misrouted request can still answer 2xx: an edge that does not recognize the
// API prefix falls through to a catch-all, and the web app's not-found page is
// HTML with a 200 status. Other topologies front the deployment with proxies
// that answer JSON, so a JSON content type alone does not prove the request
// reached the API. Every success and duplicate path of `/events/process`
// answers `{ ok: true, ... }`, so require exactly that: a handler return that
// ever stops matching fails loudly through the queue's retries, which is the
// safe direction to fail when the alternative is completing events silently.
async function assertProcessingAcknowledged(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      `Discord event processing returned a non-JSON HTTP ${response.status} response (content-type: ${contentType || 'none'})`,
    );
  }

  const acknowledgement: unknown = await response.json().catch(() => undefined);
  if (typeof acknowledgement !== 'object' || acknowledgement === null) {
    throw new Error(
      `Discord event processing returned an unreadable HTTP ${response.status} acknowledgement`,
    );
  }

  if ((acknowledgement as { ok?: unknown }).ok !== true) {
    throw new Error(
      `Discord event processing did not acknowledge HTTP ${response.status} with ok: true`,
    );
  }
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
  if (response.ok || response.status === 409) {
    await assertProcessingAcknowledged(response);
    return;
  }

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
