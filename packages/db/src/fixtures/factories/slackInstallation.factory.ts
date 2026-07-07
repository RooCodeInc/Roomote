import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { SlackInstallation, CreateSlackInstallation } from '../../types';
import { slackInstallations } from '../../schema';
import { type DatabaseOrTransaction, db } from '../../db';

export const slackInstallationFactory = Factory.define<
  CreateSlackInstallation,
  { db?: DatabaseOrTransaction },
  SlackInstallation
>(({ params, onCreate, transientParams }) => {
  onCreate(async (values) => {
    const [inserted] = await (transientParams.db || db)
      .insert(slackInstallations)
      .values(values)
      .returning();

    if (!inserted) {
      throw new Error('Failed to insert Slack installation');
    }

    return inserted;
  });

  const { installedByUserId, teamId, ...rest } = params;

  return {
    teamId: teamId || faker.string.alphanumeric(10).toUpperCase(),
    teamName: faker.company.name(),
    appId: faker.string.alphanumeric(10).toUpperCase(),
    botUserId: faker.string.alphanumeric(10).toUpperCase(),
    botAccessToken: `xoxb-${faker.string.alphanumeric(50)}`,
    scopes: {
      bot: ['app_mentions:read', 'im:history', 'chat:write', 'files:read'],
      user: [],
    },
    tokenType: 'bot',
    installedByUserId: installedByUserId || faker.string.uuid(),
    isActive: true,
    lastUsedAt: faker.helpers.maybe(() => faker.date.recent()),
    ...rest,
  } satisfies CreateSlackInstallation;
});
