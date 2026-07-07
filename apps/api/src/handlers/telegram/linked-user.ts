import {
  authUsers,
  db,
  eq,
  telegramUserMappings,
  users,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';

async function ensureRoomoteUserForAuthUser(userId: string): Promise<boolean> {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, deletedAt: true },
  });

  if (existingUser && !existingUser.deletedAt) {
    return true;
  }

  if (existingUser?.deletedAt) {
    apiLogger.warn(
      `[telegram] Skipping Telegram user mapping for auth user ${userId} because the Roomote user is deleted`,
    );
    return false;
  }

  const authUser = await db.query.authUsers.findFirst({
    where: eq(authUsers.id, userId),
    columns: { id: true, name: true, email: true, image: true },
  });

  if (!authUser) {
    apiLogger.warn(
      `[telegram] Skipping Telegram user mapping for auth user ${userId} because no auth user row exists`,
    );
    return false;
  }

  await db
    .insert(users)
    .values({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      imageUrl: authUser.image ?? '',
      entity: {
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        imageUrl: authUser.image ?? '',
      },
      metadata: {},
      onboardingCompletedAt: new Date(),
    })
    .onConflictDoNothing({ target: users.id });

  return true;
}

/**
 * Per-user attribution: a Telegram sender who linked their account (via a
 * link code) maps to their own Roomote user. Senders without a link have no
 * attribution — Roomote never acts on their message as some other user.
 */
async function findTelegramMappedUser(
  telegramUserId: string | undefined,
): Promise<string | null> {
  if (!telegramUserId) {
    return null;
  }

  const mapping = await db.query.telegramUserMappings.findFirst({
    where: eq(telegramUserMappings.telegramUserId, telegramUserId),
    columns: { userId: true },
  });

  if (!mapping) {
    return null;
  }

  const userExists = await ensureRoomoteUserForAuthUser(mapping.userId);

  return userExists ? mapping.userId : null;
}

export async function resolveTelegramSenderUserId(
  telegramUserId: string | undefined,
): Promise<string | null> {
  return findTelegramMappedUser(telegramUserId);
}

export async function upsertTelegramUserMapping(input: {
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
  userId: string;
}): Promise<void> {
  await db
    .insert(telegramUserMappings)
    .values({
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      telegramUsername: input.telegramUsername,
      userId: input.userId,
    })
    .onConflictDoUpdate({
      target: telegramUserMappings.telegramUserId,
      set: {
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername,
        userId: input.userId,
        updatedAt: new Date(),
      },
    });
}
