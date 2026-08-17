import { db, eq, users } from '@roomote/db/server';
import { Env } from '@roomote/env';

type FastAgentEntryMode = 'explicit' | 'default';

export function isFastAgentInputSupported(params: {
  hasAttachments: boolean;
}): boolean {
  return !params.hasAttachments;
}

export function resolveFastAgentEntryMode(params: {
  explicitInvocation: boolean;
  deploymentSettingEnabled: boolean;
  userDefaultEnabled: boolean;
  hasAttachments: boolean;
}): FastAgentEntryMode | null {
  if (!isFastAgentInputSupported(params)) {
    return null;
  }

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
