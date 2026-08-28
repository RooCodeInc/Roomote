import {
  and,
  db,
  eq,
  slackUserMappings,
  type SlackUserMapping,
  users,
} from '@roomote/db/server';

type SlackUserMappingLookup = {
  activeMapping:
    | (SlackUserMapping & { communicationsFastModeDefault: boolean })
    | null;
  hasInactiveMapping: boolean;
};

export async function lookupSlackUserMapping(params: {
  slackUserId: string;
  teamId: string;
}): Promise<SlackUserMappingLookup> {
  const [row] = await db
    .select({
      id: slackUserMappings.id,
      slackUserId: slackUserMappings.slackUserId,
      slackTeamId: slackUserMappings.slackTeamId,
      userId: slackUserMappings.userId,
      createdAt: slackUserMappings.createdAt,
      updatedAt: slackUserMappings.updatedAt,
      matchedUserId: users.id,
      userDeletedAt: users.deletedAt,
      userMetadata: users.metadata,
    })
    .from(slackUserMappings)
    .leftJoin(users, eq(users.id, slackUserMappings.userId))
    .where(
      and(
        eq(slackUserMappings.slackUserId, params.slackUserId),
        eq(slackUserMappings.slackTeamId, params.teamId),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      activeMapping: null,
      hasInactiveMapping: false,
    };
  }

  if (!row.matchedUserId || row.userDeletedAt) {
    return {
      activeMapping: null,
      hasInactiveMapping: true,
    };
  }

  return {
    activeMapping: {
      id: row.id,
      slackUserId: row.slackUserId,
      slackTeamId: row.slackTeamId,
      userId: row.userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      communicationsFastModeDefault: !(
        typeof row.userMetadata === 'object' &&
        row.userMetadata !== null &&
        !Array.isArray(row.userMetadata) &&
        (row.userMetadata as Record<string, unknown>)
          .communications_fast_mode_default === false
      ),
    },
    hasInactiveMapping: false,
  };
}
