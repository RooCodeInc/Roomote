import { Queue } from 'bullmq';

import type { DiscordGatewayEvent } from '@roomote/communication/discord-event';
import { getRedis } from '@roomote/redis';

export const DISCORD_GATEWAY_EVENTS_QUEUE_NAME = 'discord-gateway-events';

let discordGatewayEventsQueue: Queue<DiscordGatewayEvent> | null = null;

function getDiscordGatewayEventsQueue(): Queue<DiscordGatewayEvent> {
  if (!discordGatewayEventsQueue) {
    discordGatewayEventsQueue = new Queue<DiscordGatewayEvent>(
      DISCORD_GATEWAY_EVENTS_QUEUE_NAME,
      {
        connection: getRedis(),
        defaultJobOptions: {
          // Eight exponential backoffs total 510 seconds, exceeding the API's
          // five-minute processing lease before this job is dead-lettered.
          attempts: 9,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3600, count: 1_000 },
          // Keep exhausted jobs for inspection rather than silently dropping
          // them and allowing a redelivery to hide the original failure.
          removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
        },
      },
    );
  }

  return discordGatewayEventsQueue;
}

function discordGatewayEventJobId(event: DiscordGatewayEvent): string {
  return [
    'discord-gateway-event',
    encodeURIComponent(event.eventType),
    encodeURIComponent(event.eventId),
  ].join('-');
}

async function discordGatewayEventRedeliveryJobId(
  queue: Queue<DiscordGatewayEvent>,
  jobId: string,
): Promise<string> {
  const originalJob = await queue.getJob(jobId);
  if (!originalJob || (await originalJob.getState()) !== 'failed') {
    return jobId;
  }

  // Keep each exhausted generation for diagnosis, but do not let it prevent a
  // later gateway delivery from being queued.
  for (let generation = 1; ; generation += 1) {
    const redeliveryJobId = `${jobId}-redelivery-${generation}`;
    const redeliveryJob = await queue.getJob(redeliveryJobId);
    if (!redeliveryJob || (await redeliveryJob.getState()) !== 'failed') {
      return redeliveryJobId;
    }
  }
}

/** Persist a validated Gateway event before acknowledging the Gateway. */
export async function enqueueDiscordGatewayEvent(
  event: DiscordGatewayEvent,
): Promise<{ jobId: string }> {
  const queue = getDiscordGatewayEventsQueue();
  const jobId = await discordGatewayEventRedeliveryJobId(
    queue,
    discordGatewayEventJobId(event),
  );
  await queue.add('process-discord-gateway-event', event, {
    jobId,
  });
  return { jobId };
}
