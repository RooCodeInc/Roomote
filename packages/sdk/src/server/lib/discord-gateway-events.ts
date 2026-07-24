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
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3600, count: 1_000 },
          removeOnFail: { age: 24 * 3600 },
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

/** Persist a validated Gateway event before acknowledging the Gateway. */
export async function enqueueDiscordGatewayEvent(
  event: DiscordGatewayEvent,
): Promise<{ jobId: string }> {
  const jobId = discordGatewayEventJobId(event);
  await getDiscordGatewayEventsQueue().add(
    'process-discord-gateway-event',
    event,
    {
      jobId,
    },
  );
  return { jobId };
}
