import { db, eq, users } from '@roomote/db/server';

type FastAgentEntryMode = 'explicit' | 'default';

export function resolveFastAgentEntryMode(params: {
  explicitInvocation: boolean;
  userDefaultEnabled: boolean;
  fastAvailable?: boolean;
}): FastAgentEntryMode | null {
  if (params.explicitInvocation) {
    return 'explicit';
  }

  return params.userDefaultEnabled && params.fastAvailable !== false
    ? 'default'
    : null;
}

export async function hasCommunicationsFastModeDefault(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });
  const metadata = user?.metadata;

  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).communications_fast_mode_default ===
      true
  );
}
