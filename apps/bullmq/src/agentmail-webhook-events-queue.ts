import { DelayedError, Queue, QueueEvents, Worker, type Job } from 'bullmq';

import {
  AGENTMAIL_WEBHOOK_EVENT_QUEUE_NAME,
  AgentMailConversationBusyError,
  drainAgentMailInboundTurns,
  processAgentMailWebhookEvent,
  recoverPendingAgentMailWork,
  type AgentMailWebhookEventJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

const RECOVERY_JOB_NAME = 'recover-pending';
const RECOVERY_SCHEDULER_ID = 'agentmail-webhook-event-recovery';
const RECOVERY_INTERVAL_MS = 60_000;
const BUSY_CONVERSATION_RETRY_DELAY_MS = 1_000;

type AgentMailQueueJob = AgentMailWebhookEventJob | { recovery: true };

async function processJob(job: Job<AgentMailQueueJob>) {
  if (job.name === RECOVERY_JOB_NAME || 'recovery' in job.data) {
    await recoverPendingAgentMailWork();
    return;
  }

  if (job.data.kind === 'process') {
    await processAgentMailWebhookEvent(job.data.deliveryId);
    return;
  }

  try {
    await drainAgentMailInboundTurns(job.data.conversationId);
  } catch (error) {
    if (!(error instanceof AgentMailConversationBusyError) || !job.token) {
      throw error;
    }
    await job.moveToDelayed(
      Date.now() + BUSY_CONVERSATION_RETRY_DELAY_MS,
      job.token,
    );
    throw new DelayedError();
  }
}

export async function startAgentMailWebhookEventsQueue() {
  const connection = getRedis();
  const queue = new Queue<AgentMailQueueJob>(
    AGENTMAIL_WEBHOOK_EVENT_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  );

  await queue.upsertJobScheduler(
    RECOVERY_SCHEDULER_ID,
    { every: RECOVERY_INTERVAL_MS },
    { name: RECOVERY_JOB_NAME, data: { recovery: true } },
  );
  await recoverPendingAgentMailWork();

  const worker = new Worker<AgentMailQueueJob>(
    AGENTMAIL_WEBHOOK_EVENT_QUEUE_NAME,
    processJob,
    // Busy conversations immediately move back to delayed; no email thread
    // can park the worker pool while it owns an active Fast turn.
    { connection, concurrency: 10, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[AgentMailWebhookEventsQueue] job ${job?.id} failed: ${error.message}`,
    ),
  );
  worker.on('error', (error) =>
    console.error('[AgentMailWebhookEventsQueue] worker error:', error),
  );

  const queueEvents = new QueueEvents(AGENTMAIL_WEBHOOK_EVENT_QUEUE_NAME, {
    connection,
  });
  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[AgentMailWebhookEventsQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  return { queue, worker, queueEvents };
}
