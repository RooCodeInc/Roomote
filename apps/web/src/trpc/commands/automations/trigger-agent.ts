import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  isTriggerableBackgroundAutomationKey,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import { getAutomationRuntime } from '@roomote/db/server';
import {
  runAutomationNow,
  type AutomationRunNowResult,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

import {
  hasActiveGitHubInstallation,
  hasActiveRepository,
  hasActiveSlackInstallation,
  hasActiveSentryIntegration,
} from './automation-requirements';
import { assertAdmin } from './feature-gates';

async function assertManualTriggerIsRunnable(
  automationKey: TriggerableBackgroundAutomationKey,
) {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    throw new Error(`Unsupported automation: ${String(automationKey)}`);
  }

  const runtime = await getAutomationRuntime(automationKey);

  if (!runtime.enabled) {
    throw new Error(
      `${descriptor.label} is disabled in saved settings. Save the automation settings before running it.`,
    );
  }

  if (descriptor.usesManagerChannel && !runtime.slackChannelId) {
    throw new Error(
      `Set a Manager Channel before running ${descriptor.label}.`,
    );
  }

  for (const requirement of descriptor.manualTriggerRequirements) {
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

/**
 * Synchronous manual "Run now": invokes the automation's runner inline (the
 * same code the scheduler runs) and returns the outcome, including the
 * launched task id when the automation launches a task.
 */
export async function triggerAutomationCommand(
  auth: UserAuthSuccess,
  input: { automationKey: TriggerableBackgroundAutomationKey },
): Promise<AutomationRunNowResult> {
  assertAdmin(auth);

  if (!isTriggerableBackgroundAutomationKey(input.automationKey)) {
    throw new Error(`Unsupported automation: ${String(input.automationKey)}`);
  }

  await assertManualTriggerIsRunnable(input.automationKey);

  return runAutomationNow(input.automationKey);
}
