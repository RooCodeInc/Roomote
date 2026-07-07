import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { User, CreateUser } from '../../types';
import { users } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

export const userFactory = Factory.define<
  CreateUser,
  { db?: DatabaseOrTransaction },
  User
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(users)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert user');
    }

    return inserted;
  });

  const { id, ...rest } = params;

  return {
    id: id || faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    imageUrl: faker.image.avatar(),
    entity: {},
    lastSyncAt: new Date(),
    ...rest,
  } satisfies CreateUser;
});
