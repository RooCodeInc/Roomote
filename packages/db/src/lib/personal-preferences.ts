import { eq } from 'drizzle-orm';

import { db } from '../db';
import { users } from '../schema';

export const SLACK_PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY =
  'slack_peer_conversations_experiment_enabled';
export const PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY =
  'private_sessions_experiment_enabled';

export function isPrivateSessionsExperimentEnabledInMetadata(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY
    ] === true
  );
}

export async function isPrivateSessionsExperimentEnabledForUser(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });
  return isPrivateSessionsExperimentEnabledInMetadata(user?.metadata);
}

export function isSlackPeerConversationsExperimentEnabledInMetadata(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      SLACK_PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY
    ] === true
  );
}

export async function isSlackPeerConversationsExperimentEnabledForUser(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });

  return isSlackPeerConversationsExperimentEnabledInMetadata(user?.metadata);
}
