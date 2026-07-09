import { db, eq, sql, teamsInstallations } from '@roomote/db/server';

export type TeamsPrimaryConversation = {
  conversationId: string;
  serviceUrl: string;
  conversationType: string | null;
};

/**
 * The Teams destination for proactive output (onboarding kickoff, automation
 * summaries): the most recently active installation the bot can post back
 * into. Team (channel) installations win over personal/tenant ones so
 * summaries land where the whole team sees them.
 */
export async function findTeamsPrimaryConversation(): Promise<TeamsPrimaryConversation | null> {
  const installations = await db
    .select({
      installationKey: teamsInstallations.installationKey,
      conversationId: teamsInstallations.conversationId,
      serviceUrl: teamsInstallations.serviceUrl,
      conversationType: teamsInstallations.conversationType,
    })
    .from(teamsInstallations)
    .where(eq(teamsInstallations.isActive, true))
    // Postgres sorts DESC with NULLS FIRST by default; a row without a
    // recorded activity timestamp must not win over real ones.
    .orderBy(sql`${teamsInstallations.lastActivityAt} DESC NULLS LAST`)
    .limit(20);

  const usable = installations.filter(
    (installation) => installation.conversationId && installation.serviceUrl,
  );
  const preferred =
    usable.find((installation) =>
      installation.installationKey.startsWith('team:'),
    ) ?? usable[0];

  if (!preferred?.serviceUrl) {
    return null;
  }

  return {
    conversationId: preferred.conversationId,
    serviceUrl: preferred.serviceUrl,
    conversationType: preferred.conversationType,
  };
}
