import { and, eq, sql } from 'drizzle-orm';

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

type StoredChatInitiationPreference = {
  provider: ChatInitiationProvider;
  initiatedAt: string;
  order: string;
};

export type ChatInitiationOrder = Pick<
  StoredChatInitiationPreference,
  'initiatedAt' | 'order'
>;

let lastChatInitiationOrder = 0n;

export function createChatInitiationOrder(): ChatInitiationOrder {
  const initiatedAt = new Date();
  const clockOrder = BigInt(
    Math.floor((performance.timeOrigin + performance.now()) * 1_000),
  );
  lastChatInitiationOrder =
    clockOrder > lastChatInitiationOrder
      ? clockOrder
      : lastChatInitiationOrder + 1n;
  return {
    initiatedAt: initiatedAt.toISOString(),
    order: String(lastChatInitiationOrder),
  };
}

export function isChatInitiationProvider(
  value: unknown,
): value is ChatInitiationProvider {
  return CHAT_INITIATION_PROVIDERS.some((provider) => provider === value);
}

export async function recordUserChatInitiationProvider(
  userId: string,
  provider: ChatInitiationProvider,
  initiation: ChatInitiationOrder,
  database: DatabaseOrTransaction = db,
): Promise<void> {
  const preference: StoredChatInitiationPreference = {
    provider,
    ...initiation,
  };
  await database
    .update(users)
    .set({
      metadata: sql`${users.metadata} || ${JSON.stringify({ [LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY]: preference })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, userId),
        sql`CASE
          WHEN jsonb_typeof(${users.metadata} -> ${LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY}) = 'object'
            THEN COALESCE(
              (${users.metadata} -> ${LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY} ->> 'order')::numeric,
              '-infinity'::numeric
            ) < ${initiation.order}::numeric
          ELSE true
        END`,
      ),
    );
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
  const preference = (metadata as Record<string, unknown>)[
    LAST_CHAT_INITIATION_PROVIDER_METADATA_KEY
  ];
  if (
    !preference ||
    typeof preference !== 'object' ||
    Array.isArray(preference)
  ) {
    return null;
  }
  const provider = (preference as Partial<StoredChatInitiationPreference>)
    .provider;
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
