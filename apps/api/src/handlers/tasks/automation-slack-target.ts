import type { BackgroundAutomationKey } from '@roomote/types';
import {
  asc,
  db,
  eq,
  findActiveSlackInstallationForChannel,
  getAutomationRuntime,
  slackInstallationChannels,
  slackInstallations,
} from '@roomote/db/server';

export async function resolveAutomationSlackTargetData(
  automationKey: BackgroundAutomationKey,
) {
  const runtime = await getAutomationRuntime(automationKey);
  const configuredChannelId = runtime.slackChannelId;
  const slackInstallation =
    runtime.destination?.source === 'manager_channel' &&
    runtime.destination.provider === 'slack'
      ? await findActiveSlackInstallationForChannel(
          runtime.destination.channelId,
        )
      : (
          await db
            .select({
              id: slackInstallations.id,
              teamId: slackInstallations.teamId,
              botAccessToken: slackInstallations.botAccessToken,
            })
            .from(slackInstallations)
            .where(eq(slackInstallations.isActive, true))
            .limit(1)
        )[0];

  if (!slackInstallation) {
    return null;
  }

  const [channel] = configuredChannelId
    ? [{ channelId: configuredChannelId }]
    : await db
        .select({ channelId: slackInstallationChannels.channelId })
        .from(slackInstallationChannels)
        .where(
          eq(
            slackInstallationChannels.slackInstallationId,
            slackInstallation.id,
          ),
        )
        .orderBy(asc(slackInstallationChannels.createdAt))
        .limit(1);

  // Callers may recover a published channel from a task/team-scoped receipt.
  return { slackInstallation, channelId: channel?.channelId };
}
