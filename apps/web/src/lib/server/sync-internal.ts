import {
  type CreateUser,
  and,
  db,
  eq,
  isNull,
  users,
} from '@roomote/db/server';

type SyncInternalOptions = {
  throwOnError?: boolean;
};

function placeholderUser(userId: string): Omit<CreateUser, 'id'> {
  return {
    name: userId,
    email: '',
    imageUrl: '',
    entity: { id: userId },
    metadata: {},
  };
}

export async function syncUser(userId: string, options?: SyncInternalOptions) {
  try {
    const existingUser = await db.query.users.findFirst({
      where: and(eq(users.id, userId), isNull(users.deletedAt)),
    });

    if (existingUser) {
      await db
        .update(users)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
      return;
    }

    await db.insert(users).values({ id: userId, ...placeholderUser(userId) });
  } catch (error) {
    if (options?.throwOnError) {
      throw error;
    }
  }
}
