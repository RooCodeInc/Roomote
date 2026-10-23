import { computeProviders } from '@roomote/types';
import { db, type DatabaseOrTransaction } from '../db';
import { deploymentSettings } from '../schema';

/** Keep the no-default test configuration invisible to other connections. */
export async function withoutEligibleComputeDefault<T>(
  callback: (executor: DatabaseOrTransaction) => Promise<T>,
): Promise<T> {
  const rollback = new Error('Roll back compute-default fixture');
  let result: T;
  try {
    await db.transaction(async (tx) => {
      const runtimeComputeConfig = {
        defaultProvider: null,
        excludedProviders: [...computeProviders],
      };
      await tx
        .insert(deploymentSettings)
        .values({ id: 'default', runtimeComputeConfig })
        .onConflictDoUpdate({
          target: deploymentSettings.id,
          set: { runtimeComputeConfig },
        });
      result = await callback(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result!;
}
