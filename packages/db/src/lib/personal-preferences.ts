import { eq, sql } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { users } from '../schema';

export const CHAT_INITIATION_PROVIDERS = [
  'slack',
  'teams',
  'telegram',
  'discord',
] as const;
export type ChatInitiationProvider = (typeof CHAT_INITIATION_PROVIDERS)[number];

const LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY =
  'last_chat_initiation_provider';

export function isChatInitiationProvider(
  value: unknown,
): value is ChatInitiationProvider {
  return CHAT_INITIATION_PROVIDERS.some((provider) => provider === value);
}

export async function recordUserChatInitiationProvider(
  userId: string,
  provider: ChatInitiationProvider,
  database: DatabaseOrTransaction = db,
): Promise<void> {
  await database
    .update(users)
    .set({
      metadata: sql`${users.metadata} || ${JSON.stringify({ [LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY]: provider })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export async function getUserChatInitiationProvider(
  userId: string,
  database: DatabaseOrTransaction = db,
): Promise<ChatInitiationProvider | null> {
  const [user] = await database
    .select({ metadata: users.metadata })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const metadata = user?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const provider = (metadata as Record<string, unknown>)[
    LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY
  ];
  return isChatInitiationProvider(provider) ? provider : null;
}

export const SLACK_PEER_CONVERSATIONS_EXPERIMENT_METADATA_KEY =
  'slack_peer_conversations_experiment_enabled';

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
