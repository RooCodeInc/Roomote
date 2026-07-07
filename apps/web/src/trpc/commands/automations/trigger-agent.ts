import { Queue } from 'bullmq';
import {
  getTriggerableBackgroundAutomationDescriptor,
  hasTriggerableBackgroundAutomationManagerChannelKind,
  isTriggerableBackgroundAutomationAgentId,
  type TriggerableBackgroundAutomationAgentId,
} from '@roomote/types';
import {
  createQueuedBackgroundAutomationRun,
  db,
  getBackgroundAgentSettingsForDeployment,
  resolveManagerSlackChannelId,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

import type { UserAuthSuccess } from '@/types';

import {
  hasActiveGitHubInstallation,
  hasActiveRepository,
  hasActiveSlackInstallation,
  hasActiveSentryIntegration,
} from './automation-requirements';
import { assertAdmin } from './feature-gates';

const SCHEDULED_JOBS_QUEUE_NAME = 'scheduled-jobs';

type TriggerableAgentType = TriggerableBackgroundAutomationAgentId;

async function assertManualTriggerIsRunnable(
  auth: UserAuthSuccess,
  agentType: TriggerableAgentType,
) {
  const descriptor = getTriggerableBackgroundAutomationDescriptor(agentType);

  if (!descriptor) {
    throw new Error(`Unsupported agent type: ${String(agentType)}`);
  }

  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings[descriptor.schedule.field] === 'off') {
    throw new Error(
      `${descriptor.label} is disabled in saved settings. Save the automation settings before running it.`,
    );
  }

  if (
    hasTriggerableBackgroundAutomationManagerChannelKind(descriptor) &&
    !resolveManagerSlackChannelId(settings, descriptor.managerChannelKind)
  ) {
    throw new Error(
      `Set a Manager Channel before running ${descriptor.label}.`,
    );
  }

  for (const requirement of descriptor.manualTrigger.requirements) {
    switch (requirement) {
      case 'slack':
        if (!(await hasActiveSlackInstallation())) {
          throw new Error(`Connect Slack before running ${descriptor.label}.`);
        }
        break;
      case 'github':
        if (!(await hasActiveGitHubInstallation())) {
          throw new Error(`Connect GitHub before running ${descriptor.label}.`);
        }
        break;
      case 'repository':
        if (!(await hasActiveRepository())) {
          throw new Error(
            `Add at least one active repository before running ${descriptor.label}.`,
          );
        }
        break;
      case 'sentry':
        if (!(await hasActiveSentryIntegration())) {
          throw new Error(
            `Configure Sentry in Settings > Integrations before running ${descriptor.label}.`,
          );
        }
        break;
    }
  }
}

export async function triggerAgentCommand(
  auth: UserAuthSuccess,
  input: { agentType: TriggerableAgentType },
) {
  assertAdmin(auth);
  if (!isTriggerableBackgroundAutomationAgentId(input.agentType)) {
    throw new Error(`Unsupported agent type: ${String(input.agentType)}`);
  }
  await assertManualTriggerIsRunnable(auth, input.agentType);
  const descriptor = getTriggerableBackgroundAutomationDescriptor(
    input.agentType,
  );

  if (!descriptor) {
    throw new Error(`Unsupported agent type: ${String(input.agentType)}`);
  }

  const jobName = descriptor.manualTrigger.jobName;
  const automationKey = descriptor.automationKey;

  const queue = new Queue(SCHEDULED_JOBS_QUEUE_NAME, {
    connection: getRedis(),
  });

  let bullmqJobId: string | null = null;

  try {
    const job = await queue.add(
      jobName,
      {
        manualTrigger: true,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600 },
      },
    );

    if (job?.id != null) {
      bullmqJobId = String(job.id);

      try {
        await createQueuedBackgroundAutomationRun(db, {
          automationKey,
          bullmqJobId,
          triggerKind: 'manual',
          queuedAt: new Date(),
          metadata: {
            jobName,
          },
        });
      } catch (error) {
        console.warn(
          `[triggerAgentCommand] Failed to record queued automation run for ${automationKey} job ${bullmqJobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await queue.close();
  }

  return { triggered: true, jobName, jobId: bullmqJobId };
}
