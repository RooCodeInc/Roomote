import { eq } from 'drizzle-orm';

import { db } from '../db';
import { users } from '../schema';

// Preserve the original key so existing Slack opt-ins enable the expanded
// experiment without a migration or split preference state.
export const PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY =
  'slack_peer_conversations_experiment_enabled';

export function isPeerConversationsExperimentEnabledInMetadata(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY
    ] === true
  );
}

export async function isPeerConversationsExperimentEnabledForUser(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });

  return isPeerConversationsExperimentEnabledInMetadata(user?.metadata);
}
