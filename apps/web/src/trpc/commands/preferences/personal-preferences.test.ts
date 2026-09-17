import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  getPersonalPreferencesCommand,
  getUserPersonalizationCommand,
  updatePersonalPreferencesCommand,
  updateUserPersonalizationCommand,
} from './index';

function buildAuth(userId: string) {
  return { userId } as UserAuthSuccess;
}

describe('personal preferences', () => {
  it('returns personal preferences without dormant experiment metadata', async () => {
    const user = await userFactory.create();

    await expect(
      getPersonalPreferencesCommand(buildAuth(user.id)),
    ).resolves.toEqual(
      expect.objectContaining({
        mindReaderMode: false,
      }),
    );
  });

  it('leaves dormant per-user experiment values untouched on updates', async () => {
    const user = await userFactory.create({
      metadata: {
        results_page_enabled: true,
        slack_peer_conversations_experiment_enabled: true,
        home_composer_suggestions_enabled: true,
        integration_keys_enabled: true,
      },
    });

    const preferences = await getPersonalPreferencesCommand(buildAuth(user.id));
    expect(preferences).not.toHaveProperty('resultsPageEnabled');
    expect(preferences).not.toHaveProperty(
      'slackPeerConversationsExperimentEnabled',
    );
    expect(preferences).not.toHaveProperty('homeComposerSuggestionsEnabled');
    expect(preferences).not.toHaveProperty('serviceCredentialToolsEnabled');

    await updatePersonalPreferencesCommand(buildAuth(user.id), {
      narrationMode: true,
    });

    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { metadata: true },
    });

    expect(storedUser?.metadata).toEqual({
      results_page_enabled: true,
      slack_peer_conversations_experiment_enabled: true,
      home_composer_suggestions_enabled: true,
      integration_keys_enabled: true,
      narration_mode: true,
    });
  });

  it.each([undefined, false])(
    'ignores a legacy therapist mode value of %s without dropping it on updates',
    async (therapistMode) => {
      const user = await userFactory.create({
        metadata: {
          existing_value: 'preserved',
          ...(therapistMode === undefined
            ? {}
            : { therapist_mode: therapistMode }),
        },
      });

      const preferences = await getPersonalPreferencesCommand(
        buildAuth(user.id),
      );
      expect(preferences).not.toHaveProperty('therapistMode');

      await updatePersonalPreferencesCommand(buildAuth(user.id), {
        mindReaderMode: true,
      });

      const storedUser = await db.query.users.findFirst({
        where: eq(users.id, user.id),
        columns: { metadata: true },
      });

      expect(storedUser?.metadata).toEqual({
        existing_value: 'preserved',
        ...(therapistMode === undefined
          ? {}
          : { therapist_mode: therapistMode }),
        mind_reader_mode: true,
      });
    },
  );

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

  it('preserves concurrent updates to different preferences', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);

    await Promise.all([
      updatePersonalPreferencesCommand(auth, { mindReaderMode: true }),
      updatePersonalPreferencesCommand(auth, { narrationMode: true }),
    ]);

    await expect(getPersonalPreferencesCommand(auth)).resolves.toEqual(
      expect.objectContaining({
        mindReaderMode: true,
        narrationMode: true,
      }),
    );
  });

  it('keeps personalization owner-scoped even when another user is an admin', async () => {
    const [owner, admin] = await Promise.all([
      userFactory.create(),
      userFactory.create({ role: 'admin' }),
    ]);
    await updateUserPersonalizationCommand(buildAuth(owner.id), {
      expectedVersion: 0,
      instructions: 'PRIVATE_SENTINEL',
    });

    await expect(
      getUserPersonalizationCommand(buildAuth(admin.id)),
    ).resolves.toEqual({
      instructions: '',
      learnFromConversations: true,
      version: 0,
    });
  });

  it('maps stale personalization writes to a conflict without overwriting', async () => {
    const user = await userFactory.create();
    const auth = buildAuth(user.id);
    await updateUserPersonalizationCommand(auth, {
      expectedVersion: 0,
      instructions: 'First edit',
    });

    await expect(
      updateUserPersonalizationCommand(auth, {
        expectedVersion: 0,
        instructions: 'Stale edit',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(getUserPersonalizationCommand(auth)).resolves.toMatchObject({
      instructions: 'First edit',
      version: 1,
    });
  });
});
