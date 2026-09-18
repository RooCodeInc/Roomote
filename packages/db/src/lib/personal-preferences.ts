import { and, eq, sql } from 'drizzle-orm';
import type { AutomationTarget } from '@roomote/types';

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
const DEFAULT_AUTOMATION_TARGET_METADATA_KEY = 'default_automation_target';

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

export async function getUserDefaultAutomationTarget(
  userId: string,
  database: DatabaseOrTransaction = db,
): Promise<AutomationTarget | null> {
  const [user] = await database
    .select({ metadata: users.metadata })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const metadata = user?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const target = (metadata as Record<string, unknown>)[
    DEFAULT_AUTOMATION_TARGET_METADATA_KEY
  ];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const candidate = target as Partial<AutomationTarget>;
  return typeof candidate.provider === 'string' &&
    typeof candidate.targetKind === 'string' &&
    typeof candidate.externalRef === 'string' &&
    candidate.externalRef.length > 0
    ? (target as AutomationTarget)
    : null;
}

export async function setUserDefaultAutomationTarget(
  userId: string,
  target: AutomationTarget | null,
  database: DatabaseOrTransaction = db,
): Promise<void> {
  await database
    .update(users)
    .set({
      metadata: target
        ? sql`${users.metadata} || ${JSON.stringify({ [DEFAULT_AUTOMATION_TARGET_METADATA_KEY]: target })}::jsonb`
        : sql`${users.metadata} - ${DEFAULT_AUTOMATION_TARGET_METADATA_KEY}`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
