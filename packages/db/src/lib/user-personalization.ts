import { and, eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { decrypt } from './encryption';
import { userPersonalizations, users } from '../schema';

export const USER_PERSONALIZATION_MAX_CHARS = 8_000;
const CONVERSATION_PREFERENCE_MAX_CHARS = 500;

export type UserPersonalization = {
  instructions: string;
  learnFromConversations: boolean;
  version: number;
  resetAt: Date | null;
};

export class UserPersonalizationConflictError extends Error {
  constructor() {
    super('Personalization changed in another session. Refresh and try again.');
    this.name = 'UserPersonalizationConflictError';
  }
}

function decryptValue(value: string | null): string {
  return value ? decrypt(value) : '';
}

function joinInstructions(...values: string[]): string {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, USER_PERSONALIZATION_MAX_CHARS);
}

export async function getUserPersonalization(
  userId: string,
): Promise<UserPersonalization> {
  const row = await db.query.userPersonalizations.findFirst({
    where: eq(userPersonalizations.userId, userId),
  });

  if (!row) {
    return {
      instructions: '',
      learnFromConversations: true,
      version: 0,
      resetAt: null,
    };
  }

  return {
    instructions: joinInstructions(
      decryptValue(row.manualInstructions),
      decryptValue(row.explicitConversationInstructions),
      decryptValue(row.inferredInstructions),
    ),
    learnFromConversations: row.learnFromConversations,
    version: row.version,
    resetAt: row.resetAt,
  };
}

export async function updateUserPersonalization(input: {
  userId: string;
  expectedVersion: number;
  instructions?: string;
  learnFromConversations?: boolean;
  reset?: boolean;
}): Promise<UserPersonalization> {
  const now = new Date();
  const restartLearning =
    !input.reset &&
    ((input.instructions?.trim().length ?? 0) > 0 ||
      input.learnFromConversations === true);

  await db.transaction(async (tx) => {
    if (input.expectedVersion === 0) {
      await tx
        .insert(userPersonalizations)
        .values({ userId: input.userId })
        .onConflictDoNothing();
    }

    const [updated] = await tx
      .update(userPersonalizations)
      .set({
        ...(input.reset
          ? {
              manualInstructions: null,
              explicitConversationInstructions: null,
              inferredInstructions: null,
              resetAt: now,
            }
          : input.instructions !== undefined
            ? {
                manualInstructions: input.instructions.trim() || null,
                explicitConversationInstructions: null,
                inferredInstructions: null,
              }
            : {}),
        ...(input.learnFromConversations !== undefined
          ? { learnFromConversations: input.learnFromConversations }
          : {}),
        ...(restartLearning ? { resetAt: null } : {}),
        version: sql`${userPersonalizations.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(userPersonalizations.userId, input.userId),
          eq(userPersonalizations.version, input.expectedVersion),
        ),
      )
      .returning({ version: userPersonalizations.version });

    if (!updated) {
      throw new UserPersonalizationConflictError();
    }
  });

  return getUserPersonalization(input.userId);
}

export async function appendLearnedUserPreference(input: {
  userId: string;
  preference: string;
  confidence: 'explicit' | 'inferred';
}): Promise<{
  saved: boolean;
  reason?: 'disabled' | 'duplicate' | 'full' | 'reset_boundary';
}> {
  const preference = input.preference
    .trim()
    .slice(0, CONVERSATION_PREFERENCE_MAX_CHARS);
  if (!preference) return { saved: false, reason: 'duplicate' };

  return db.transaction(async (tx) => {
    await tx
      .insert(userPersonalizations)
      .values({ userId: input.userId })
      .onConflictDoNothing();

    const [row] = await tx
      .select()
      .from(userPersonalizations)
      .where(eq(userPersonalizations.userId, input.userId))
      .for('update');
    if (!row?.learnFromConversations)
      return { saved: false, reason: 'disabled' };
    if (row.resetAt && input.confidence === 'inferred') {
      return { saved: false, reason: 'reset_boundary' };
    }

    const manual = decryptValue(row.manualInstructions);
    const explicit = decryptValue(row.explicitConversationInstructions);
    const inferred = decryptValue(row.inferredInstructions);
    const combined = joinInstructions(manual, explicit, inferred);
    if (combined.toLocaleLowerCase().includes(preference.toLocaleLowerCase())) {
      return { saved: false, reason: 'duplicate' };
    }

    const current = input.confidence === 'explicit' ? explicit : inferred;
    const addition = `- ${preference}`;
    if (
      [manual, explicit, inferred, addition].filter(Boolean).join('\n').length >
      USER_PERSONALIZATION_MAX_CHARS
    ) {
      return { saved: false, reason: 'full' };
    }
    const next = joinInstructions(current, addition);

    await tx
      .update(userPersonalizations)
      .set({
        ...(input.confidence === 'explicit'
          ? { explicitConversationInstructions: next, resetAt: null }
          : { inferredInstructions: next }),
        version: sql`${userPersonalizations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(userPersonalizations.userId, input.userId));

    return { saved: true };
  });
}

export async function getUserPersonalizationRuntimeContext(
  userId: string | null | undefined,
): Promise<{
  displayName: string | null;
  instructions: string;
  learnFromConversations: boolean;
} | null> {
  if (!userId) return null;

  const [user, row] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, deletedAt: true },
    }),
    db.query.userPersonalizations.findFirst({
      where: eq(userPersonalizations.userId, userId),
    }),
  ]);
  if (!user || user.deletedAt) return null;

  const manual = decryptValue(row?.manualInstructions ?? null);
  const explicit = decryptValue(row?.explicitConversationInstructions ?? null);
  const inferred = decryptValue(row?.inferredInstructions ?? null);
  const instructions = [
    manual ? `Manually edited preferences (highest priority):\n${manual}` : '',
    explicit
      ? `Preferences explicitly stated in conversation:\n${explicit}`
      : '',
    inferred
      ? `Tentative inferred preferences (lowest priority):\n${inferred}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    displayName: row?.resetAt ? null : user.name.trim() || null,
    instructions,
    learnFromConversations: row?.learnFromConversations ?? true,
  };
}
