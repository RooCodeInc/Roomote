import { db, users, inArray } from '@roomote/db/server';

export type SimpleUser = {
  id: string;
  name: string;
  email: string;
  imageUrl: string;
};

export const getUsersById = async (
  ids: string[],
): Promise<Record<string, SimpleUser>> => {
  if (ids.length === 0) {
    return {};
  }

  const results = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      imageUrl: users.imageUrl,
    })
    .from(users)
    .where(inArray(users.id, ids));

  return results.reduce(
    (acc, user) => ({ ...acc, [user.id]: user }),
    {} as Record<string, SimpleUser>,
  );
};
