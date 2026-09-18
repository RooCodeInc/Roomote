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
import { buildChannelAutomationTarget } from '@roomote/types';

export async function provisionSlackManagerChannel(
  installation: SlackInstallation,
): Promise<void> {
  try {
    if (!installation.isActive) return;

    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: {
        managerSlackChannelId: true,
        managerDiscordChannelId: true,
        defaultAutomationTarget: true,
      },
    });
    if (
      settings?.managerSlackChannelId != null ||
      settings?.managerDiscordChannelId != null ||
      settings?.defaultAutomationTarget != null
    ) {
      return;
    }

    const channelId = await ensureSlackManagerChannel(
      installation.botAccessToken,
    );
    if (!channelId) return;
    const defaultAutomationTarget = buildChannelAutomationTarget(
      'slack',
      channelId,
    );

    await db.transaction(async (tx) => {
      await tx
        .insert(slackInstallationChannels)
        .values({ slackInstallationId: installation.id, channelId })
        .onConflictDoNothing();

      // Recheck in the write: another auth or an admin may have chosen a
      // manager while Slack was responding. Never update automation targets.
      await tx
        .insert(deploymentSettings)
        .values({
          id: 'default',
          managerSlackChannelId: channelId,
          defaultAutomationTarget,
        })
        .onConflictDoUpdate({
          target: deploymentSettings.id,
          set: {
            managerSlackChannelId: channelId,
            defaultAutomationTarget,
            updatedAt: new Date(),
          },
          setWhere: and(
            isNull(deploymentSettings.managerSlackChannelId),
            isNull(deploymentSettings.managerDiscordChannelId),
            isNull(deploymentSettings.defaultAutomationTarget),
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
