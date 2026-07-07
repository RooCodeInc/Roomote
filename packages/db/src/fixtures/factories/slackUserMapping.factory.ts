import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { SlackUserMapping, CreateSlackUserMapping } from '../../types';
import { slackUserMappings } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

export const slackUserMappingFactory = Factory.define<
  CreateSlackUserMapping,
  { db?: DatabaseOrTransaction },
  SlackUserMapping
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(slackUserMappings)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert Slack user mapping');
    }

    return inserted;
  });

  const { userId, slackUserId, slackTeamId, ...rest } = params;

  return {
    userId: userId || faker.string.uuid(),
    slackUserId: slackUserId || faker.string.alphanumeric(11).toUpperCase(),
    slackTeamId: slackTeamId || faker.string.alphanumeric(11).toUpperCase(),
    ...rest,
  } satisfies CreateSlackUserMapping;
});
