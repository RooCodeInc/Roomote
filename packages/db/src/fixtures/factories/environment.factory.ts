import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { Environment, CreateEnvironment } from '../../types';
import { environments } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

export const environmentFactory = Factory.define<
  CreateEnvironment,
  { db?: DatabaseOrTransaction },
  Environment
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(environments)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert environment');
    }

    return inserted;
  });

  const envName = params.name || faker.lorem.words(2);

  return {
    userId: params.userId,
    createdByUserId: params.createdByUserId || faker.string.uuid(),
    name: envName,
    description: params.description,
    config: (params.config as CreateEnvironment['config']) || {
      name: envName,
      repositories: [
        { repository: `${faker.internet.userName()}/${faker.lorem.slug()}` },
      ],
    },
    isEval: params.isEval ?? false,
    snapshotId: params.snapshotId,
    snapshotStatus: params.snapshotStatus,
    snapshotExpiresAt: params.snapshotExpiresAt,
  } satisfies CreateEnvironment;
});
