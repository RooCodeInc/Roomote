import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  getPersonalPreferencesCommand,
  updatePersonalPreferencesCommand,
} from './index';

function buildAuth(userId: string) {
  return { userId } as UserAuthSuccess;
}

describe('personal preferences', () => {
  it('defaults mind reader mode to disabled', async () => {
    const user = await userFactory.create();

    await expect(
      getPersonalPreferencesCommand(buildAuth(user.id)),
    ).resolves.toEqual(expect.objectContaining({ mindReaderMode: false }));
  });

  it('persists mind reader mode without replacing other metadata', async () => {
    const user = await userFactory.create({
      metadata: { existing_value: 'preserved' },
    });

    await expect(
      updatePersonalPreferencesCommand(buildAuth(user.id), {
        mindReaderMode: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ mindReaderMode: true }));

    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { metadata: true },
    });

    expect(storedUser?.metadata).toEqual(
      expect.objectContaining({
        existing_value: 'preserved',
        mind_reader_mode: true,
      }),
    );
  });
});
