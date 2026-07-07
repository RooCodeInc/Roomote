import {
  and,
  db,
  eq,
  slackUserMappings,
  type SlackInstallation,
} from '@roomote/db/server';

export async function getSlackAutomationLaunchIdentity({
  slackInstallation,
  teamId,
  slackUserId,
}: {
  slackInstallation: SlackInstallation;
  teamId: string;
  slackUserId?: string;
}): Promise<{ launchUserId: string; slackUserId: string }> {
  const [installerMapping] = await db
    .select({ slackUserId: slackUserMappings.slackUserId })
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.userId, slackInstallation.installedByUserId),
        eq(slackUserMappings.slackTeamId, teamId),
      ),
    )
    .limit(1);

  return {
    launchUserId: slackInstallation.installedByUserId,
    slackUserId:
      slackUserId ??
      installerMapping?.slackUserId ??
      slackInstallation.botUserId,
  };
}
