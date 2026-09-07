import {
  db,
  deploymentSettings,
  automations,
  eq,
  slackInstallationFactory,
  slackInstallations,
  userFactory,
  users,
  upsertAutomation,
  type SlackInstallation,
} from '@roomote/db/server';
import type {
  SlackNotifier,
  SlackMemberJoinedChannelEvent,
} from '@roomote/slack';
import { maybePostSlackChannelWelcome } from './member-joined';
import { SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT } from '../constants';

describe('Slack membership welcome', () => {
  let installation: SlackInstallation;
  let userId: string;
  const postMessage = vi.fn();
  const listPublicChannels = vi.fn();
  const slack = { postMessage, listPublicChannels } as unknown as SlackNotifier;
  const welcome = (channel = 'CJOINED', user = installation.botUserId!) =>
    maybePostSlackChannelWelcome({
      event: { channel, user } as SlackMemberJoinedChannelEvent,
      slackInstallation: installation,
      slack,
    });

  beforeEach(async () => {
    vi.resetAllMocks();
    await db.delete(deploymentSettings);
    await db.delete(automations);
    const user = await userFactory.create();
    userId = user.id;
    installation = await slackInstallationFactory.create({
      installedByUserId: user.id,
    });
    listPublicChannels.mockResolvedValue([
      { id: 'CJOINED', name: 'roomote-managers' },
    ]);
    postMessage.mockResolvedValue({});
  });

  afterEach(async () => {
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.id, installation.id));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(deploymentSettings);
    await db.delete(automations);
  });

  it.each([false, true])(
    'registers an unconfigured public manager channel (settings exist: %s) without creating starters',
    async (existing) => {
      if (existing) await db.insert(deploymentSettings).values({});
      await welcome();
      expect(
        (await db.query.deploymentSettings.findFirst())?.managerSlackChannelId,
      ).toBe('CJOINED');
      expect(await db.select().from(automations)).toEqual([]);
      expect(postMessage.mock.calls[0]![0].text).toContain(
        'set it as your Manager Channel',
      );
      expect(postMessage.mock.calls[0]![0].text).not.toContain('enabled');
    },
  );

  it.each(['CJOINED', 'CEXPLICIT'])(
    'preserves existing manager and automation configuration (%s)',
    async (channel) => {
      await db
        .insert(deploymentSettings)
        .values({ managerSlackChannelId: channel });
      await upsertAutomation(db, {
        key: 'suggester',
        enabled: false,
        schedule: { mode: 'off' },
        instructions: 'Keep my instructions',
        targets: [
          {
            provider: 'slack',
            targetKind: 'slack_channel',
            externalRef: 'CTARGET',
          },
        ],
        managedTargetKinds: ['slack_channel'],
        updatedAt: new Date(),
      });
      const settings = await db.select().from(deploymentSettings);
      const starters = await db.select().from(automations);
      await welcome();
      expect(await db.select().from(deploymentSettings)).toEqual(settings);
      expect(await db.select().from(automations)).toEqual(starters);
      expect(postMessage.mock.calls[0]![0].text).not.toContain('enabled');
    },
  );

  it.each(['managerSlackChannelId', 'managerDiscordChannelId'] as const)(
    'preserves a racing explicit %s choice',
    async (field) => {
      listPublicChannels.mockImplementationOnce(async () => {
        await db.insert(deploymentSettings).values({ [field]: 'EXPLICIT' });
        return [{ id: 'CJOINED', name: 'roomote-managers' }];
      });
      await welcome();
      expect((await db.query.deploymentSettings.findFirst())?.[field]).toBe(
        'EXPLICIT',
      );
      expect(postMessage.mock.calls[0]![0].text).toContain('Hi humans');
    },
  );

  it('preserves an existing Discord manager destination', async () => {
    await db
      .insert(deploymentSettings)
      .values({ managerDiscordChannelId: 'DISCORD' });
    await welcome();
    expect(
      (await db.query.deploymentSettings.findFirst())?.managerSlackChannelId,
    ).toBeNull();
    expect(postMessage.mock.calls[0]![0].text).toContain('Hi humans');
  });

  it('does not discover private channels and deduplicates ordinary welcomes', async () => {
    listPublicChannels.mockResolvedValue([]);
    await welcome();
    await welcome();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0].text).toContain('Hi humans');
    expect(await db.query.deploymentSettings.findFirst()).toBeUndefined();
  });

  it('ignores human joins and limits ordinary welcomes', async () => {
    listPublicChannels.mockResolvedValue([]);
    await welcome('CHUMAN', 'UHUMAN');
    for (let i = 0; i <= SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT; i++)
      await welcome(`C${i}`);
    expect(postMessage).toHaveBeenCalledTimes(
      SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT,
    );
  });

  it.each([false, true])(
    'retries failed welcomes without rolling back a concurrent destination (manager: %s)',
    async (manager) => {
      if (!manager) listPublicChannels.mockResolvedValue([]);
      postMessage.mockImplementationOnce(async () => {
        await db
          .insert(deploymentSettings)
          .values({ managerSlackChannelId: 'CCHOICE' })
          .onConflictDoUpdate({
            target: deploymentSettings.id,
            set: { managerSlackChannelId: 'CCHOICE' },
          });
        throw new Error('Slack unavailable');
      });
      await expect(welcome()).rejects.toThrow('Slack unavailable');
      expect(
        (await db.query.deploymentSettings.findFirst())?.managerSlackChannelId,
      ).toBe('CCHOICE');
      await welcome();
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(await db.select().from(automations)).toEqual([]);
    },
  );
});
