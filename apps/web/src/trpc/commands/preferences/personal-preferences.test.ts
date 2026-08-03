import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  getPersonalPreferencesCommand,
  updatePersonalPreferencesCommand,
} from './index';

describe('personal preferences', () => {
  it('atomically preserves independent and unrelated metadata updates', async () => {
    const user = await userFactory.create({
      metadata: { unrelated_setting: 'keep-me' },
    });
    const auth = { userId: user.id } as UserAuthSuccess;

    await Promise.all([
      updatePersonalPreferencesCommand(auth, { narrationMode: true }),
      updatePersonalPreferencesCommand(auth, { showCommandOutput: true }),
    ]);

    await expect(getPersonalPreferencesCommand(auth)).resolves.toEqual({
      colorTheme: 'system',
      narrationMode: true,
      showCommandOutput: true,
    });

    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { metadata: true },
    });

    expect(storedUser?.metadata).toMatchObject({
      unrelated_setting: 'keep-me',
      narration_mode: true,
      show_command_output: true,
    });
  });
});
