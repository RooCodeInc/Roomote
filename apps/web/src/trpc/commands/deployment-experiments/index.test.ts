import { db, eq, userFactory, users } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  getDeploymentExperimentsCommand,
  getNightlyExperimentsCommand,
  getNightlyExperimentRuntimeCommand,
  setDeploymentExperimentCommand,
  setNightlyExperimentCommand,
} from './index';

function auth(
  userId: string,
  isAdmin: boolean,
  nightlyExperimentsEnabled = false,
): UserAuthSuccess {
  return { userId, isAdmin, nightlyExperimentsEnabled } as UserAuthSuccess;
}

describe('deployment experiment commands', () => {
  it('ignores legacy per-user Results metadata when reading shared experiments', async () => {
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
    expect(firstValues).not.toHaveProperty('results');
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
        id: 'privateSessions',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');

    await expect(
      setDeploymentExperimentCommand(auth(admin.id, true), {
        id: 'privateSessions',
        enabled: true,
      }),
    ).resolves.toMatchObject({ privateSessions: true });
    await expect(
      getDeploymentExperimentsCommand(auth(member.id, false)),
    ).resolves.toMatchObject({ privateSessions: true });

    await expect(
      db.query.users.findFirst({
        where: eq(users.id, member.id),
        columns: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: { results_page_enabled: true },
    });
  });

  it('blocks customer admins and members from nightly data and mutations', async () => {
    const [admin, member] = await Promise.all([
      userFactory.create({ role: 'admin' }),
      userFactory.create({ role: 'member' }),
    ]);

    await expect(
      getNightlyExperimentsCommand(auth(admin.id, true, false)),
    ).rejects.toThrow('Unauthorized');
    await expect(
      setNightlyExperimentCommand(auth(admin.id, true, false), {
        id: 'privateSessions',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');

    await expect(
      getNightlyExperimentsCommand(auth(member.id, false, true)),
    ).rejects.toThrow('Unauthorized');
    await expect(
      setNightlyExperimentCommand(auth(member.id, false, true), {
        id: 'privateSessions',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('allows an enabled internal admin to read nightly values without moving customer previews', async () => {
    const admin = await userFactory.create({ role: 'admin' });

    await expect(
      getNightlyExperimentsCommand(auth(admin.id, true, true)),
    ).resolves.toEqual({
      integrationToolAutoApprovals: false,
      dizzy: false,
      automationLaunchCriteria: false,
    });
    await expect(
      getDeploymentExperimentsCommand(auth(admin.id, true, true)),
    ).resolves.toHaveProperty('privateSessions');
    await expect(
      setNightlyExperimentCommand(auth(admin.id, true, true), {
        id: 'privateSessions',
        enabled: true,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('keeps launch criteria on the Nightly control path and out of customer previews', async () => {
    const admin = await userFactory.create({ role: 'admin' });
    const internalAuth = auth(admin.id, true, true);

    await expect(
      setNightlyExperimentCommand(internalAuth, {
        id: 'automationLaunchCriteria',
        enabled: true,
      }),
    ).resolves.toMatchObject({ automationLaunchCriteria: true });
    await expect(
      getNightlyExperimentsCommand(internalAuth),
    ).resolves.toMatchObject({ automationLaunchCriteria: true });
    await expect(
      getDeploymentExperimentsCommand(internalAuth),
    ).resolves.not.toHaveProperty('automationLaunchCriteria');
    await expect(
      setDeploymentExperimentCommand(internalAuth, {
        id: 'automationLaunchCriteria',
        enabled: false,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('serves only the Dizzy runtime value on deployments opted in to nightly experiments', async () => {
    const [admin, member] = await Promise.all([
      userFactory.create({ role: 'admin' }),
      userFactory.create({ role: 'member' }),
    ]);

    await expect(
      getNightlyExperimentRuntimeCommand(auth(member.id, false, false), {
        id: 'dizzy',
      }),
    ).rejects.toThrow('Unauthorized');
    await expect(
      getNightlyExperimentRuntimeCommand(auth(member.id, false, true), {
        id: 'dizzy',
      }),
    ).resolves.toBe(false);

    await setNightlyExperimentCommand(auth(admin.id, true, true), {
      id: 'dizzy',
      enabled: true,
    });

    await expect(
      getNightlyExperimentRuntimeCommand(auth(member.id, false, true), {
        id: 'dizzy',
      }),
    ).resolves.toBe(true);
    await expect(
      getNightlyExperimentRuntimeCommand(auth(member.id, false, true), {
        id: 'automationLaunchCriteria',
      }),
    ).rejects.toThrow('Unauthorized');
    await expect(
      getNightlyExperimentsCommand(auth(member.id, false, true)),
    ).rejects.toThrow('Unauthorized');
  });
});
