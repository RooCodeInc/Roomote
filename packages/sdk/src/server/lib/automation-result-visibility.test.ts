import { randomUUID } from 'node:crypto';

import {
  customAutomations,
  db,
  eq,
  slackInstallationChannels,
  slackInstallations,
  userFactory,
  users,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

import { resolveCustomAutomationResultVisibility } from './automation-result-visibility';

async function createAutomation(
  name: string,
  target: typeof customAutomations.$inferInsert.target,
) {
  const [automation] = await db
    .insert(customAutomations)
    .values({ name, prompt: 'Summarize activity.', target })
    .returning({ id: customAutomations.id });
  return automation!;
}

describe('automation result visibility', () => {
  it('shares destinationless and confirmed shared-channel output but excludes private and unknown destinations', async () => {
    const suffix = randomUUID();
    const automations = await Promise.all([
      createAutomation(`No destination ${suffix}`, {}),
      createAutomation(`Email ${suffix}`, {
        provider: 'email',
        targetKind: 'email_user',
        externalRef: `user-${suffix}`,
      }),
      createAutomation(`Direct message ${suffix}`, {
        provider: 'teams',
        targetKind: 'teams_user',
        externalRef: `user-${suffix}`,
      }),
      createAutomation(`Teams channel ${suffix}`, {
        provider: 'teams',
        targetKind: 'teams_channel',
        externalRef: `teams-channel-${suffix}`,
      }),
      createAutomation(`Discord channel ${suffix}`, {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: `discord-public-${suffix}`,
      }),
      createAutomation(`Unknown Telegram chat ${suffix}`, {
        provider: 'telegram',
        targetKind: 'telegram_chat',
        externalRef: `telegram-${suffix}`,
      }),
      createAutomation(`Unknown channel ${suffix}`, {
        provider: 'discord',
        targetKind: 'discord_channel',
        externalRef: `missing-${suffix}`,
      }),
    ]);

    try {
      await expect(
        Promise.all(
          automations.map(({ id }) =>
            resolveCustomAutomationResultVisibility(id),
          ),
        ),
      ).resolves.toEqual([
        'shared',
        'private',
        'private',
        'private',
        'private',
        'private',
        'private',
      ]);
    } finally {
      for (const automation of automations) {
        await db
          .delete(customAutomations)
          .where(eq(customAutomations.id, automation.id));
      }
    }
  });

  it('shares only Slack channels authoritatively reported as public', async () => {
    const suffix = randomUUID();
    const user = await userFactory.create();
    const [installation] = await db
      .insert(slackInstallations)
      .values({
        teamId: `T-${suffix}`,
        teamName: 'Test team',
        appId: `A-${suffix}`,
        botUserId: `U-${suffix}`,
        botAccessToken: `xoxb-${suffix}`,
        scopes: [],
        installedByUserId: user.id,
      })
      .returning({ id: slackInstallations.id });
    await db.insert(slackInstallationChannels).values([
      {
        slackInstallationId: installation!.id,
        channelId: `C-public-${suffix}`,
      },
      {
        slackInstallationId: installation!.id,
        channelId: `G-private-${suffix}`,
      },
    ]);
    const [publicAutomation, privateAutomation] = await Promise.all([
      createAutomation(`Slack public ${suffix}`, {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: `C-public-${suffix}`,
      }),
      createAutomation(`Slack private ${suffix}`, {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: `G-private-${suffix}`,
      }),
    ]);
    const listChannels = vi
      .spyOn(SlackNotifier.prototype, 'listAccessibleChannels')
      .mockResolvedValue([
        {
          id: `C-public-${suffix}`,
          name: 'public',
          isPrivate: false,
          isMember: true,
        },
        {
          id: `G-private-${suffix}`,
          name: 'private',
          isPrivate: true,
          isMember: true,
        },
      ]);

    try {
      await expect(
        Promise.all([
          resolveCustomAutomationResultVisibility(publicAutomation.id),
          resolveCustomAutomationResultVisibility(privateAutomation.id),
        ]),
      ).resolves.toEqual(['shared', 'private']);
    } finally {
      listChannels.mockRestore();
      await db
        .delete(customAutomations)
        .where(eq(customAutomations.id, publicAutomation.id));
      await db
        .delete(customAutomations)
        .where(eq(customAutomations.id, privateAutomation.id));
      await db
        .delete(slackInstallations)
        .where(eq(slackInstallations.id, installation!.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
