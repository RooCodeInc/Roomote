import {
  customAutomations,
  db,
  eq,
  findActiveSlackInstallationForChannel,
  getAutomationRuntime,
  tasks,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import {
  isAutomationDestinationTarget,
  isBackgroundAutomationUserTargetKind,
  isConfiguredAutomationTarget,
  type AutomationResultVisibility,
  type AutomationTarget,
  type BackgroundAutomationKey,
} from '@roomote/types';

async function resolveTargetVisibility(
  target: AutomationTarget,
): Promise<AutomationResultVisibility> {
  if (
    target.provider === 'email' ||
    isBackgroundAutomationUserTargetKind(target.targetKind)
  ) {
    return 'private';
  }

  if (target.provider === 'slack' && target.targetKind === 'slack_channel') {
    const installation = await findActiveSlackInstallationForChannel(
      target.externalRef,
    );
    if (!installation) return 'private';

    try {
      const channel = (
        await new SlackNotifier(
          installation.botAccessToken,
        ).listAccessibleChannels()
      ).find((candidate) => candidate.id === target.externalRef);
      return channel && !channel.isPrivate ? 'shared' : 'private';
    } catch {
      return 'private';
    }
  }

  // Teams channel membership, Discord permission overwrites, and Telegram chat
  // type are not persisted, so none can prove deployment-shared visibility.
  return 'private';
}

async function resolveTargetsVisibility(
  targets: readonly AutomationTarget[],
): Promise<AutomationResultVisibility> {
  const destinations = targets.filter(isAutomationDestinationTarget);
  if (destinations.length === 0) return 'shared';

  const visibility = await Promise.all(
    destinations.map(resolveTargetVisibility),
  );
  return visibility.every((value) => value === 'shared') ? 'shared' : 'private';
}

export async function resolveCustomAutomationResultVisibility(
  automationId: string,
): Promise<AutomationResultVisibility> {
  const automation = await db.query.customAutomations.findFirst({
    columns: { target: true },
    where: eq(customAutomations.id, automationId),
  });
  if (!automation || !isConfiguredAutomationTarget(automation.target)) {
    return automation ? 'shared' : 'private';
  }
  return resolveTargetsVisibility([automation.target]);
}

export async function resolveTaskAutomationResultVisibility(
  taskId: string,
): Promise<AutomationResultVisibility> {
  const task = await db.query.tasks.findFirst({
    columns: { initiatorAutomation: true, actorExternalId: true },
    where: eq(tasks.id, taskId),
  });
  if (!task?.initiatorAutomation) return 'private';

  if (task.initiatorAutomation === 'custom_automation') {
    return task.actorExternalId
      ? resolveCustomAutomationResultVisibility(task.actorExternalId)
      : 'private';
  }

  return resolveBackgroundAutomationResultVisibility(task.initiatorAutomation);
}

export async function resolveBackgroundAutomationResultVisibility(
  automationKey: BackgroundAutomationKey,
): Promise<AutomationResultVisibility> {
  const runtime = await getAutomationRuntime(automationKey);
  const configuredDestinations = runtime.targets.filter(
    isAutomationDestinationTarget,
  );
  if (configuredDestinations.length > 0) {
    return resolveTargetsVisibility(configuredDestinations);
  }

  // The deployment default can be a DM or Email, which the channel-only
  // `runtime.destination` cannot express.
  if (runtime.defaultAutomationTarget) {
    return resolveTargetsVisibility([runtime.defaultAutomationTarget]);
  }
  if (!runtime.destination) return 'shared';
  if (runtime.destination.provider !== 'slack') return 'private';
  return resolveTargetsVisibility([
    {
      provider: 'slack',
      targetKind: 'slack_channel',
      externalRef: runtime.destination.channelId,
    },
  ]);
}
