import { db, eq, users } from '@roomote/db/server';
import { Env } from '@roomote/env';

export type FastAgentEntryMode = 'explicit' | 'default';

export function shouldShowFastAgentProcessingReaction(params: {
  entryMode: FastAgentEntryMode;
  hasExistingSession: boolean;
}): boolean {
  return params.entryMode === 'explicit' || !params.hasExistingSession;
}

export function resolveFastAgentEntryMode(params: {
  explicitInvocation: boolean;
  deploymentSettingEnabled: boolean;
  userDefaultEnabled: boolean;
}): FastAgentEntryMode | null {
  if (params.explicitInvocation) {
    return 'explicit';
  }

  return params.deploymentSettingEnabled && params.userDefaultEnabled
    ? 'default'
    : null;
}

export async function hasCommunicationsFastModeDefault(
  userId: string,
): Promise<boolean> {
  if (Env.R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED !== true) {
    return false;
  }

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
