import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { acceptVoiceConsentCommand, getVoiceConsentCommand } from './index';

function buildAuth(userId: string, cloudEnabled = true) {
  return { userId, cloudEnabled } as UserAuthSuccess;
}

describe('voice consent', () => {
  it('persists acceptance for only the active user without replacing metadata', async () => {
    const [acceptingUser, otherUser] = await Promise.all([
      userFactory.create({ metadata: { existing_value: 'preserved' } }),
      userFactory.create(),
    ]);

    await expect(
      getVoiceConsentCommand(buildAuth(acceptingUser.id)),
    ).resolves.toBe(false);
    await expect(
      acceptVoiceConsentCommand(buildAuth(acceptingUser.id)),
    ).resolves.toBe(true);
    await expect(
      getVoiceConsentCommand(buildAuth(acceptingUser.id)),
    ).resolves.toBe(true);
    await expect(getVoiceConsentCommand(buildAuth(otherUser.id))).resolves.toBe(
      false,
    );

    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, acceptingUser.id),
      columns: { metadata: true },
    });
    expect(storedUser?.metadata).toEqual({
      existing_value: 'preserved',
      voice_consent_accepted: true,
    });
  });

  it('rejects acceptance writes outside Roomote Cloud', async () => {
    const user = await userFactory.create();

    await expect(
      acceptVoiceConsentCommand(buildAuth(user.id, false)),
    ).rejects.toThrow('Voice consent is only available on Roomote Cloud.');
  });
});
