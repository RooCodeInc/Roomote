import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  getAutomationAdditionalRules,
  isAutomationAdditionalRulesRepositoryAllowed,
  isTriggerableBackgroundAutomationKey,
  type CommunicationProvider,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import { getAutomationRuntime } from '@roomote/db/server';
import {
  resolveAutomationRuntimeDestination,
  resolveAutomationRepositoryDestination,
  listConnectedCommunicationProviders,
  runAutomationNow,
  type AutomationRunNowResult,
  type ResolvedAutomationDestination,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { getRepositories } from '@/lib/server/source-control';

import {
  hasActiveGitHubInstallation,
  hasActiveRepository,
  hasActiveSlackInstallation,
  hasActiveSentryIntegration,
} from './automation-requirements';
import { assertAdmin } from './feature-gates';

async function assertManualTriggerIsRunnable(
  automationKey: TriggerableBackgroundAutomationKey,
  auth: UserAuthSuccess,
): Promise<ResolvedAutomationDestination | null> {
  const descriptor =
    getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

  if (!descriptor) {
    throw new Error(`Unsupported automation: ${String(automationKey)}`);
  }

  const runtime = await getAutomationRuntime(automationKey);
  let hasAdditionalRules = false;
  let rulesDestination: ResolvedAutomationDestination | null = null;

  if (!runtime.enabled) {
    throw new Error(
      `${descriptor.label} is disabled in saved settings. Save the automation settings before running it.`,
    );
  }

  if ('additionalRules' in descriptor) {
    const rules = getAutomationAdditionalRules(runtime.settings);
    if (rules !== undefined) {
      hasAdditionalRules = true;
      if (rules === null) {
        throw new Error(
          `${descriptor.label} Additional rules are invalid. Save them again before running the automation.`,
        );
      }
      const repositories = (await getRepositories(auth)).filter(
        (repo) =>
          descriptor.supportedSourceControlProviders.some(
            (provider) => provider === repo.sourceControlProvider,
          ) &&
          isAutomationAdditionalRulesRepositoryAllowed(
            runtime.settings,
            repo.id,
          ),
      );
      if (!repositories.length)
        throw new Error(
          `Select at least one active repository before running ${descriptor.label}.`,
        );
      const connectedProviders = await listConnectedCommunicationProviders();
      for (const repository of repositories) {
        const repositoryDestination =
          await resolveAutomationRepositoryDestination({
            runtime,
            repositoryId: repository.id,
            connectedProviders,
          });
        if (repositoryDestination) {
          // Keep this only as a preflight signal. The runner must still resolve
          // each repository independently rather than treating it as a default.
          rulesDestination = repositoryDestination;
          break;
        }
      }
      if (!rulesDestination) {
        throw new Error(
          `Configure an available destination for the selected ${descriptor.label} repositories.`,
        );
      }
    }
  }

  const slackConnected = await hasActiveSlackInstallation();
  const destination = descriptor.usesManagerChannel
    ? await resolveAutomationRuntimeDestination({
        runtime,
        slackConnected,
        fallbackUserId: auth.userId,
      })
    : null;
  const preflightDestination = destination ?? rulesDestination;

  if (descriptor.usesManagerChannel) {
    if (!preflightDestination) {
      throw new Error(
        `Set a Manager Channel before running ${descriptor.label}.`,
      );
    }

    const supportedProviders: readonly CommunicationProvider[] =
      descriptor.supportedCommunicationProviders;

    if (!supportedProviders.includes(preflightDestination.provider)) {
      throw new Error(
        `${descriptor.label} cannot report to ${preflightDestination.provider} yet. Choose a Slack channel or the shared Manager Channel.`,
      );
    }
  }

  for (const requirement of descriptor.manualTriggerRequirements) {
    switch (requirement) {
      case 'slack':
        // A supported non-Slack destination satisfies the comms requirement;
        // the Slack connection itself is only needed when the report goes to
        // Slack.
        if (preflightDestination && preflightDestination.provider !== 'slack') {
          break;
        }
        if (!slackConnected) {
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

  return hasAdditionalRules ? null : destination;
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

  const destination = await assertManualTriggerIsRunnable(
    input.automationKey,
    auth,
  );

  return runAutomationNow(input.automationKey, {
    ...(destination ? { destination } : {}),
  });
}
