import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const CUSTOM_AUTOMATION_RUN_QUEUE_NAME = 'custom-automation-runs';
export const CUSTOM_AUTOMATION_RUN_JOB_NAME = 'run-custom-automation';

export const customAutomationRunJobSchema = z.object({
  automationId: z.string().uuid(),
  launchClaimedAt: z.string().datetime(),
});

export type CustomAutomationRunJob = z.infer<
  typeof customAutomationRunJobSchema
>;

export type CustomAutomationRunStatus = {
  automationId: string;
  invocationId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string;
};

let queue: Queue<CustomAutomationRunJob, void, string> | null = null;

function getQueue(): Queue<CustomAutomationRunJob, void, string> {
  queue ??= new Queue<CustomAutomationRunJob, void, string>(
    CUSTOM_AUTOMATION_RUN_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60, count: 500 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
      },
    },
  );
  return queue;
}

export async function enqueueCustomAutomationRun(params: {
  automationId: string;
  launchClaimedAt: Date;
}): Promise<string> {
  const invocationId = `${params.automationId}-${params.launchClaimedAt.getTime()}`;
  await getQueue().add(
    CUSTOM_AUTOMATION_RUN_JOB_NAME,
    {
      automationId: params.automationId,
      launchClaimedAt: params.launchClaimedAt.toISOString(),
    },
    { jobId: invocationId },
  );
  return invocationId;
}

export async function getCustomAutomationRunStatus(params: {
  automationId: string;
  invocationId: string;
}): Promise<CustomAutomationRunStatus | null> {
  const job = await getQueue().getJob(params.invocationId);
  if (!job || job.data.automationId !== params.automationId) return null;

  const state = await job.getState();
  if (state === 'completed') {
    return { ...params, status: 'succeeded' };
  }
  if (state === 'failed') {
    return {
      ...params,
      status: 'failed',
      error: job.failedReason || 'Custom automation run failed.',
    };
  }
  return {
    ...params,
    status: state === 'active' ? 'running' : 'queued',
  };
}
