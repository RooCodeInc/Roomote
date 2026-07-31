import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { acceptCookieConsentCommand } from './index';

function buildAuth(userId: string, cloudEnabled = true) {
  return { userId, cloudEnabled } as UserAuthSuccess;
}

describe('acceptCookieConsentCommand', () => {
  it('records consent once without replacing its original timestamp', async () => {
    const user = await userFactory.create();

    const firstConsent = await acceptCookieConsentCommand(buildAuth(user.id));
    const secondConsent = await acceptCookieConsentCommand(buildAuth(user.id));
    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { cookieConsentedAt: true },
    });

    expect(firstConsent).toEqual(secondConsent);
    expect(storedUser?.cookieConsentedAt).toEqual(firstConsent);
  });

  it('rejects consent writes outside Roomote Cloud', async () => {
    const user = await userFactory.create();

    await expect(
      acceptCookieConsentCommand(buildAuth(user.id, false)),
    ).rejects.toThrow('Cookie consent is only available on Roomote Cloud.');
  });
});
