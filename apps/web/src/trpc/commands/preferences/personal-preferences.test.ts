import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { R_SLACK_FAST_MODE_SETTING_ENABLED: false },
}));

vi.mock('@/lib/server/env', () => ({ Env: mockEnv }));

import {
  getPersonalPreferencesCommand,
  updatePersonalPreferencesCommand,
} from './index';

function buildAuth(userId: string) {
  return { userId } as UserAuthSuccess;
}

describe('personal preferences', () => {
  beforeEach(() => {
    mockEnv.R_SLACK_FAST_MODE_SETTING_ENABLED = false;
  });

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

  it('rejects Slack fast mode updates when the deployment setting is disabled', async () => {
    const user = await userFactory.create();

    await expect(
      updatePersonalPreferencesCommand(buildAuth(user.id), {
        slackFastModeDefault: true,
      }),
    ).rejects.toThrow(
      'The Slack fast mode default setting is not enabled for this deployment.',
    );
  });

  it('does not expose a stored Slack fast mode default when the deployment setting is disabled', async () => {
    const user = await userFactory.create({
      metadata: { slack_fast_mode_default: true },
    });

    await expect(
      getPersonalPreferencesCommand(buildAuth(user.id)),
    ).resolves.toEqual(
      expect.objectContaining({ slackFastModeDefault: false }),
    );
  });

  it('persists the Slack fast mode default when the deployment setting is enabled', async () => {
    mockEnv.R_SLACK_FAST_MODE_SETTING_ENABLED = true;
    const user = await userFactory.create();

    await expect(
      updatePersonalPreferencesCommand(buildAuth(user.id), {
        slackFastModeDefault: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ slackFastModeDefault: true }));

    const storedUser = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { metadata: true },
    });

    expect(storedUser?.metadata).toEqual(
      expect.objectContaining({ slack_fast_mode_default: true }),
    );
  });
});
