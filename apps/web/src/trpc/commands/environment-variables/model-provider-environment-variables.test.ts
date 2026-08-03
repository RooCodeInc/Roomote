import {
  db,
  environmentVariables,
  modelProviderEnvironmentVariables,
} from '@roomote/db/server';
import { decryptSecrets } from '@roomote/db/encryption';

import {
  deleteModelProviderEnvironmentVariables,
  upsertModelProviderEnvironmentVariables,
} from './index';

describe('model-provider environment-variable persistence', () => {
  beforeEach(async () => {
    await db.delete(modelProviderEnvironmentVariables);
    await db.delete(environmentVariables);
  });

  it('dual-writes model values for N-1 rollback compatibility', async () => {
    await db.transaction((tx) =>
      upsertModelProviderEnvironmentVariables(tx, {
        userId: null,
        values: [{ name: 'TOGETHER_API_KEY', value: ' together-key ' }],
      }),
    );

    const [modelRows, legacyRows] = await Promise.all([
      db.select().from(modelProviderEnvironmentVariables),
      db.select().from(environmentVariables),
    ]);

    expect(modelRows).toHaveLength(1);
    expect(modelRows[0]).toMatchObject({
      name: 'TOGETHER_API_KEY',
    });
    await expect(decryptSecrets(modelRows[0]?.value)).resolves.toBe(
      ' together-key ',
    );
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]).toMatchObject({
      name: 'TOGETHER_API_KEY',
    });
    await expect(decryptSecrets(legacyRows[0]?.value)).resolves.toBe(
      ' together-key ',
    );
  });

  it('deletes model values from both stores during the compatibility release', async () => {
    await db.transaction(async (tx) => {
      await upsertModelProviderEnvironmentVariables(tx, {
        userId: null,
        values: [{ name: 'TOGETHER_API_KEY', value: 'together-key' }],
      });
      await deleteModelProviderEnvironmentVariables(tx, ['TOGETHER_API_KEY']);
    });

    const [modelRows, legacyRows] = await Promise.all([
      db.select().from(modelProviderEnvironmentVariables),
      db.select().from(environmentVariables),
    ]);

    expect(modelRows).toEqual([]);
    expect(legacyRows).toEqual([]);
  });
});
