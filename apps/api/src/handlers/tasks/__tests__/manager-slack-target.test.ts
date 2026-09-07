import {
  automations,
  db,
  deploymentSettings,
  eq,
  slackInstallationChannels,
  slackInstallationFactory,
  slackInstallations,
  taskFactory,
  tasks,
  trackedMessages,
  upsertAutomation,
  userFactory,
  users,
  workItems,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import { resolveAutomationSlackTarget } from '../automation-work-items/slack';
import { resolveScheduledSuggestionSlackConfig } from '../background-automation-slack';
import { postSuggestedTasksSummaryToSlack } from '../submitTaskSuggestions';

vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: { getOrCreate: vi.fn() },
  findEnvironmentForRepo: vi.fn(),
}));
vi.mock('@roomote/sdk/server', () => ({
  buildAutomationRootSummaryMessage: ({
    summaryText,
  }: {
    summaryText: string;
  }) => ({ text: summaryText }),
  buildAutomationRootSummaryText: ({ summaryText }: { summaryText: string }) =>
    summaryText,
  enqueueSlackSuggestedTasksOnboardingFollowup: vi.fn(),
  shouldPostHistoricalThreadFeedbackDebugSnippet: vi.fn(),
}));
vi.mock('../scheduled-suggestion-root-summary', () => ({
  buildScheduledSuggestionRootMessage: async () => ({
    summaryText: 'Summary',
    actionFooterText: 'Footer',
  }),
}));

const { tokens, postMessage } = vi.hoisted(() => ({
  tokens: [] as string[],
  postMessage: vi.fn(),
}));
vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  SlackNotifier: class {
    constructor(token: string) {
      tokens.push(token);
    }
    postMessage = postMessage;
  },
}));

describe.each(['work items', 'scheduled suggestions'] as const)(
  '%s manager Slack ownership',
  (consumer) => {
    let userId: string;
    let taskId: string;
    let suggestion: Parameters<
      typeof postSuggestedTasksSummaryToSlack
    >[0]['suggestions'][number];

    beforeEach(async () => {
      tokens.length = 0;
      postMessage.mockReset().mockResolvedValue('123.456');
      await db.delete(deploymentSettings);
      await db.delete(automations);
      await upsertAutomation(db, {
        key: 'suggester',
        enabled: false,
        schedule: { mode: 'off' },
        instructions: '',
        updatedAt: new Date(),
      });
      userId = (await userFactory.create()).id;
      taskId = (await taskFactory.create({ initiatorUserId: userId })).id;
      const [row] = await db
        .insert(workItems)
        .values({
          kind: 'suggestion',
          sourceTaskId: taskId,
          title: 'Fix parser',
          brief: 'Handle missing input',
          sortOrder: 0,
        })
        .returning();
      suggestion = { ...row!, brief: row!.brief! };
    });

    afterEach(async () => {
      await db
        .delete(trackedMessages)
        .where(eq(trackedMessages.threadTs, '123.456'));
      await db.delete(tasks).where(eq(tasks.id, taskId));
      await db
        .delete(slackInstallations)
        .where(eq(slackInstallations.installedByUserId, userId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(deploymentSettings);
      await db.delete(automations);
    });

    async function installation(token: string, isActive = true) {
      return slackInstallationFactory.create({
        installedByUserId: userId,
        botAccessToken: token,
        isActive,
      });
    }
    async function map(slackInstallationId: string, channelId = 'CMANAGER') {
      await db
        .insert(slackInstallationChannels)
        .values({ slackInstallationId, channelId });
    }
    async function deliver(channelId: string | null, token?: string) {
      if (consumer === 'work items') {
        const target = await resolveAutomationSlackTarget({
          slackConfig: resolveScheduledSuggestionSlackConfig(undefined),
        });
        if (channelId) {
          expect(target).toEqual({
            channelId,
            slack: expect.any(SlackNotifier),
          });
        } else expect(target).toBeNull();
      } else {
        expect(
          await postSuggestedTasksSummaryToSlack({
            sourceTaskId: taskId,
            createdByUserId: null,
            suggestions: [suggestion],
          }),
        ).toBe(Boolean(channelId));
        if (channelId) {
          expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ channel: channelId }),
          );
          const receipt = await db.query.trackedMessages.findFirst({
            where: eq(trackedMessages.kind, 'automation_thread'),
          });
          const owner = (await db.query.slackInstallations.findMany()).find(
            (installation) => installation.botAccessToken === token,
          );
          expect(receipt?.metadata).toMatchObject({
            slackTeamId: owner!.teamId,
          });
        } else expect(postMessage).not.toHaveBeenCalled();
      }
      expect(tokens).toEqual(token ? [token] : []);
    }

    it('uses owner B token even when active A was inserted first', async () => {
      await installation('token-a');
      const b = await installation('token-b');
      await map(b.id);
      await db
        .insert(deploymentSettings)
        .values({ managerSlackChannelId: 'CMANAGER' });
      await deliver('CMANAGER', 'token-b');
    });

    it.each(['inactive', 'ambiguous', 'unmapped'] as const)(
      'fails closed for %s manager ownership without channel fallback',
      async (state) => {
        const a = await installation('token-a');
        const b = await installation('token-b', state !== 'inactive');
        await map(a.id, 'CFALLBACK');
        if (state !== 'unmapped') await map(b.id);
        if (state === 'ambiguous') await map(a.id);
        await db
          .insert(deploymentSettings)
          .values({ managerSlackChannelId: 'CMANAGER' });
        await deliver(null);
      },
    );

    it('preserves an explicit automation destination over an inaccessible manager', async () => {
      await installation('token-a');
      await map((await installation('token-b', false)).id);
      await db
        .insert(deploymentSettings)
        .values({ managerSlackChannelId: 'CMANAGER' });
      await upsertAutomation(db, {
        key: 'suggester',
        enabled: false,
        schedule: { mode: 'off' },
        instructions: '',
        updatedAt: new Date(),
        targets: [
          {
            provider: 'slack',
            targetKind: 'slack_channel',
            externalRef: 'CEXPLICIT',
          },
        ],
        managedTargetKinds: ['slack_channel'],
      });
      await deliver('CEXPLICIT', 'token-a');
    });

    it('preserves first-installation channel fallback without configuration', async () => {
      const a = await installation('token-a');
      await installation('token-b');
      await map(a.id, 'CFALLBACK');
      await deliver('CFALLBACK', 'token-a');
    });

    it('supports an unmapped legacy manager with a sole active installation', async () => {
      await installation('token-a');
      await db
        .insert(deploymentSettings)
        .values({ managerSlackChannelId: 'CMANAGER' });
      await deliver('CMANAGER', 'token-a');
    });
  },
);
