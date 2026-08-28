import { faker } from '@faker-js/faker';
import { Factory } from 'fishery';

import { type DatabaseOrTransaction, db } from '../../db';
import { sessions } from '../../schema';
import type { CreateSession, Session } from '../../types';

export const sessionFactory = Factory.define<
  CreateSession,
  { db?: DatabaseOrTransaction },
  Session
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(sessions)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert session');
    }

    return inserted;
  });

  return {
    title: faker.lorem.sentence(),
    ownerKind: 'system',
    sourceSurface: 'system',
    sourceTrigger: 'manual',
    visibility: 'visible',
    activityAt: Math.floor(Date.now() / 1000),
    cachedStatus: 'ready',
    ...params,
  } satisfies CreateSession;
});
