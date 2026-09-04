import { userFactory } from '@roomote/db/server';

import { getTherapistModeEnabledForUser } from './therapist-mode';

describe('getTherapistModeEnabledForUser', () => {
  it('defaults to disabled when the user has no saved preference', async () => {
    const user = await userFactory.create();

    await expect(getTherapistModeEnabledForUser(user.id)).resolves.toBe(false);
  });

  it('returns the saved per-user preference', async () => {
    const enabledUser = await userFactory.create({
      metadata: { therapist_mode: true },
    });
    const disabledUser = await userFactory.create({
      metadata: { therapist_mode: false },
    });

    await expect(getTherapistModeEnabledForUser(enabledUser.id)).resolves.toBe(
      true,
    );
    await expect(getTherapistModeEnabledForUser(disabledUser.id)).resolves.toBe(
      false,
    );
  });
});
