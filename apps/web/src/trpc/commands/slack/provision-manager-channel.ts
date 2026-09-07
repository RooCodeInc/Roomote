import {
  and,
  db,
  deploymentSettings,
  eq,
  isNull,
  slackInstallationChannels,
  type SlackInstallation,
} from '@roomote/db/server';
import { ensureSlackManagerChannel } from '@roomote/slack';

export async function provisionSlackManagerChannel(
  installation: SlackInstallation,
): Promise<void> {
  try {
    if (!installation.isActive) return;

    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { managerSlackChannelId: true, managerDiscordChannelId: true },
    });
    if (
      settings?.managerSlackChannelId != null ||
      settings?.managerDiscordChannelId != null
    ) {
      return;
    }

    const channelId = await ensureSlackManagerChannel(
      installation.botAccessToken,
    );
    if (!channelId) return;

    await db.transaction(async (tx) => {
      await tx
        .insert(slackInstallationChannels)
        .values({ slackInstallationId: installation.id, channelId })
        .onConflictDoNothing();

      // Recheck in the write: another auth or an admin may have chosen a
      // manager while Slack was responding. Never update automation targets.
      await tx
        .insert(deploymentSettings)
        .values({ id: 'default', managerSlackChannelId: channelId })
        .onConflictDoUpdate({
          target: deploymentSettings.id,
          set: { managerSlackChannelId: channelId, updatedAt: new Date() },
          setWhere: and(
            isNull(deploymentSettings.managerSlackChannelId),
            isNull(deploymentSettings.managerDiscordChannelId),
          ),
        });
    });
  } catch {
    // Slack errors can contain request headers and bot tokens.
    console.warn(
      '[provisionSlackManagerChannel] Best-effort provisioning failed',
    );
  }
}
