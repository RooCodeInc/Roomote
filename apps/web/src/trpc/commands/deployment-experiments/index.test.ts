import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  getDeploymentExperimentsCommand,
  setDeploymentExperimentCommand,
} from './index';

function auth(userId: string, isAdmin: boolean): UserAuthSuccess {
  return { userId, isAdmin } as UserAuthSuccess;
}

describe('deployment experiment commands', () => {
  it('returns one fail-closed value set for users with conflicting legacy preferences', async () => {
    const [first, second] = await Promise.all([
      userFactory.create({
        metadata: {
          results_page_enabled: true,
          integration_keys_enabled: true,
        },
      }),
      userFactory.create({
        metadata: {
          results_page_enabled: false,
          integration_keys_enabled: false,
        },
      }),
    ]);

    const firstValues = await getDeploymentExperimentsCommand(
      auth(first.id, false),
    );
    const secondValues = await getDeploymentExperimentsCommand(
      auth(second.id, false),
    );

    expect(firstValues).toEqual(secondValues);
  });

  it('allows only admins to update shared values and leaves user metadata dormant', async () => {
    const [admin, member] = await Promise.all([
      userFactory.create({ role: 'admin' }),
      userFactory.create({
        metadata: { results_page_enabled: true },
        role: 'member',
      }),
    ]);

    await expect(
      setDeploymentExperimentCommand(auth(member.id, false), {
        id: 'results',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');

    await expect(
      setDeploymentExperimentCommand(auth(admin.id, true), {
        id: 'results',
        enabled: true,
      }),
    ).resolves.toMatchObject({ results: true });
    await expect(
      getDeploymentExperimentsCommand(auth(member.id, false)),
    ).resolves.toMatchObject({ results: true });

    await expect(
      db.query.users.findFirst({
        where: eq(users.id, member.id),
        columns: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: { results_page_enabled: true },
    });
  });
});
