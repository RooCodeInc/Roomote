import { and, eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { decrypt } from './encryption';
import {
  fastAgentPersonalizationSnapshots,
  userPersonalizations,
  users,
} from '../schema';

export const USER_PERSONALIZATION_MAX_CHARS = 8_000;
const CONVERSATION_PREFERENCE_MAX_CHARS = 500;

export type UserPersonalization = {
  instructions: string;
  learnFromConversations: boolean;
  version: number;
  resetAt: Date | null;
};

export type UserPersonalizationRuntimeContext = {
  displayName: string | null;
  instructions: string;
  learnFromConversations: boolean;
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
  supersedes?: string[];
  fastConversationId?: string;
}): Promise<{
  saved: boolean;
  reason?: 'disabled' | 'duplicate' | 'full' | 'reset_boundary' | 'no_change';
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
    if (!row) return { saved: false, reason: 'disabled' };
    const learningEnabled = input.fastConversationId
      ? (
          await tx.query.fastAgentPersonalizationSnapshots.findFirst({
            where: and(
              eq(
                fastAgentPersonalizationSnapshots.conversationId,
                input.fastConversationId,
              ),
              eq(fastAgentPersonalizationSnapshots.userId, input.userId),
            ),
            columns: { learnFromConversations: true },
          })
        )?.learnFromConversations === true
      : row.learnFromConversations;
    if (!learningEnabled) return { saved: false, reason: 'disabled' };
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

    const superseded = new Set(
      (input.supersedes ?? []).map((value) => value.trim().toLocaleLowerCase()),
    );
    const removeSuperseded = (value: string) =>
      value
        .split('\n')
        .filter(
          (line) =>
            !superseded.has(
              line
                .replace(/^[-*]\s*/, '')
                .trim()
                .toLocaleLowerCase(),
            ),
        )
        .join('\n');
    const nextExplicit = removeSuperseded(explicit);
    const nextInferred = removeSuperseded(inferred);
    const nextManual =
      input.confidence === 'explicit' ? removeSuperseded(manual) : manual;
    const current =
      input.confidence === 'explicit' ? nextExplicit : nextInferred;
    const addition = `- ${preference}`;
    const nextLearned = joinInstructions(current, addition);
    if (
      joinInstructions(
        nextManual,
        nextLearned,
        input.confidence === 'explicit' ? nextInferred : '',
      ).length > USER_PERSONALIZATION_MAX_CHARS
    ) {
      return { saved: false, reason: 'full' };
    }

    await tx
      .update(userPersonalizations)
      .set({
        ...(input.confidence === 'explicit'
          ? {
              manualInstructions: nextManual || null,
              explicitConversationInstructions: nextLearned || null,
              inferredInstructions: nextInferred || null,
              resetAt: null,
            }
          : { inferredInstructions: nextLearned || null }),
        version: sql`${userPersonalizations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(userPersonalizations.userId, input.userId));

    return { saved: true };
  });
}

export async function getUserPersonalizationRuntimeContext(
  userId: string | null | undefined,
): Promise<UserPersonalizationRuntimeContext | null> {
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

function decryptFastAgentPersonalizationSnapshot(row: {
  displayName: string | null;
  instructions: string | null;
  learnFromConversations: boolean;
}): UserPersonalizationRuntimeContext {
  return {
    displayName: row.displayName ? decrypt(row.displayName) : null,
    instructions: decryptValue(row.instructions),
    learnFromConversations: row.learnFromConversations,
  };
}

export async function getOrCreateFastAgentPersonalizationSnapshot(input: {
  conversationId: string;
  userId: string;
}): Promise<UserPersonalizationRuntimeContext | null> {
  return db.transaction(async (tx) => {
    const where = and(
      eq(
        fastAgentPersonalizationSnapshots.conversationId,
        input.conversationId,
      ),
      eq(fastAgentPersonalizationSnapshots.userId, input.userId),
    );
    const existing = await tx.query.fastAgentPersonalizationSnapshots.findFirst(
      { where },
    );
    if (existing) return decryptFastAgentPersonalizationSnapshot(existing);

    const [user, personalization] = await Promise.all([
      tx.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { name: true, deletedAt: true },
      }),
      tx.query.userPersonalizations.findFirst({
        where: eq(userPersonalizations.userId, input.userId),
      }),
    ]);
    if (!user || user.deletedAt) return null;

    const manual = decryptValue(personalization?.manualInstructions ?? null);
    const explicit = decryptValue(
      personalization?.explicitConversationInstructions ?? null,
    );
    const inferred = decryptValue(
      personalization?.inferredInstructions ?? null,
    );
    const context: UserPersonalizationRuntimeContext = {
      displayName: personalization?.resetAt ? null : user.name.trim() || null,
      instructions: [
        manual
          ? `Manually edited preferences (highest priority):\n${manual}`
          : '',
        explicit
          ? `Preferences explicitly stated in conversation:\n${explicit}`
          : '',
        inferred
          ? `Tentative inferred preferences (lowest priority):\n${inferred}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      learnFromConversations: personalization?.learnFromConversations ?? true,
    };

    await tx
      .insert(fastAgentPersonalizationSnapshots)
      .values({
        conversationId: input.conversationId,
        userId: input.userId,
        displayName: context.displayName,
        instructions: context.instructions,
        learnFromConversations: context.learnFromConversations,
      })
      .onConflictDoNothing();

    const snapshot = await tx.query.fastAgentPersonalizationSnapshots.findFirst(
      { where },
    );
    return snapshot ? decryptFastAgentPersonalizationSnapshot(snapshot) : null;
  });
}
