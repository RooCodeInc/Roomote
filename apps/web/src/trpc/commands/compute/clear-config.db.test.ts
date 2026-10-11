import type { DatabaseOrTransaction } from '@roomote/db/server';
import { deploymentSettings, eq } from '@roomote/db/server';
import type { DeploymentComputeConfig } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';

const fixture = vi.hoisted(() => ({
  tx: null as DatabaseOrTransaction | null,
}));
vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...actual,
    db: {
      transaction: async (
        callback: (tx: DatabaseOrTransaction) => Promise<unknown>,
      ) => {
        if (!fixture.tx) throw new Error('Missing fixture transaction');
        return callback(fixture.tx);
      },
    },
  };
});
const { db } =
  await vi.importActual<typeof import('@roomote/db/server')>(
    '@roomote/db/server',
  );

import { clearComputeConfigCommand } from './index';

describe('compute configuration removal persistence', () => {
  it.each(['blaxel', 'modal'] as const)(
    'clears a removed %s default while preserving other saved compute settings',
    async (provider) => {
      const rollback = new Error('roll back fixture');
      const config: DeploymentComputeConfig = {
        defaultProvider: provider,
        excludedProviders: ['docker'],
      };
      try {
        await expect(
          db.transaction(async (tx) => {
            await tx
              .insert(deploymentSettings)
              .values({ id: 'default', runtimeComputeConfig: config })
              .onConflictDoUpdate({
                target: deploymentSettings.id,
                set: { runtimeComputeConfig: config },
              });
            // Keep the command's transaction inside the isolated fixture transaction.
            fixture.tx = tx;

            await clearComputeConfigCommand(
              { isAdmin: true } as UserAuthSuccess,
              { provider },
            );

            const row = await tx.query.deploymentSettings.findFirst({
              where: eq(deploymentSettings.id, 'default'),
            });
            expect(row?.runtimeComputeConfig).toEqual({
              ...config,
              defaultProvider: null,
            });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      } finally {
        fixture.tx = null;
      }
    },
  );

  it('preserves a different saved default when removing another provider', async () => {
    const rollback = new Error('roll back fixture');
    const config: DeploymentComputeConfig = {
      defaultProvider: 'docker',
      excludedProviders: ['modal'],
    };
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx
            .insert(deploymentSettings)
            .values({ id: 'default', runtimeComputeConfig: config })
            .onConflictDoUpdate({
              target: deploymentSettings.id,
              set: { runtimeComputeConfig: config },
            });
          fixture.tx = tx;

          await clearComputeConfigCommand(
            { isAdmin: true } as UserAuthSuccess,
            { provider: 'blaxel' },
          );

          const row = await tx.query.deploymentSettings.findFirst({
            where: eq(deploymentSettings.id, 'default'),
          });
          expect(row?.runtimeComputeConfig).toEqual(config);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      fixture.tx = null;
    }
  });
});
