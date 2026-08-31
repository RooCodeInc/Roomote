import { db, environments, eq, userFactory, users } from '@roomote/db/server';

import { getAvailableEnvironments } from '../context-builders';

describe('getAvailableEnvironments', () => {
  it('returns shared environments without exposing user-owned environments', async () => {
    const owner = await userFactory.create();
    const sharedName = `shared-environment-${crypto.randomUUID()}`;
    const privateName = `private-environment-${crypto.randomUUID()}`;
    const [sharedEnvironment, privateEnvironment] = await db
      .insert(environments)
      .values([
        {
          name: sharedName,
          config: { name: sharedName, repositories: [] },
          userId: null,
        },
        {
          name: privateName,
          config: { name: privateName, repositories: [] },
          userId: owner.id,
        },
      ])
      .returning({ id: environments.id });

    try {
      const availableEnvironments = await getAvailableEnvironments();

      expect(availableEnvironments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: sharedEnvironment!.id }),
        ]),
      );
      expect(availableEnvironments).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: privateEnvironment!.id }),
        ]),
      );
    } finally {
      await db
        .delete(environments)
        .where(eq(environments.id, sharedEnvironment!.id));
      await db
        .delete(environments)
        .where(eq(environments.id, privateEnvironment!.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
