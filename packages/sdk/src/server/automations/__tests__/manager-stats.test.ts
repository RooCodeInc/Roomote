vi.mock('@roomote/env', () => ({
  Env: {
    R_APP_URL: 'https://app.example.com',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: { select: vi.fn() },
  githubInstallations: {},
  repositories: {},
  slackInstallations: {},
  getAutomationRuntime: vi.fn(),
  recordAutomationRunOutcome: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('../../lib/manager-slack', () => ({
  buildAutomationSettingsMessage: (text: string, hash: string) => ({
    text: text.trim(),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: text.trim(),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Configure this in <https://app.example.com/automations#${hash}|automation settings>.`,
          },
        ],
      },
    ],
  }),
}));

vi.mock('../../lib/manager-stats', () => ({
  buildManagerStatsDigest: vi.fn(),
}));

vi.mock('../github-deployment-scope', () => ({
  hasAnyActiveRepository: vi.fn(async () => true),
}));

vi.mock('../destination', () => ({
  resolveAutomationRuntimeDestination: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(),
}));

vi.mock('../../lib/communication-providers', () => ({
  getCommunicationProviderAdapter: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('../scheduling-utils', () => ({
  isWeeklyRunDueOnLocalDay: vi.fn(),
  resolveSlackWorkspaceTimezone: vi.fn(),
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveDeploymentTimeZone: vi.fn(async () => ({
    timeZone: 'UTC',
    source: 'utc_fallback',
    updatedAt: null,
  })),
}));

import {
  db,
  getAutomationRuntime,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';
import { buildManagerStatsDigest } from '../../lib/manager-stats';
import { resolveAutomationRuntimeDestination } from '../destination';
import { isWeeklyRunDueOnLocalDay } from '../scheduling-utils';
import { formatManagerStatsMessage, managerStatsJob } from '../manager-stats';

const stats = {
  activeUsers: 3,
  roomotePullRequests: 4,
  authoredPullRequests: 3,
  reviewedPullRequests: 1,
  roomotePullRequestPercentage: 40,
  totalPullRequests: 10,
  mergedRoomotePullRequests: 2,
  mergedRoomotePullRequestPercentage: 67,
  additions: 123,
  deletions: 45,
  locScope: 'all' as const,
  mostActiveRepo: {
    fullName: 'acme/app',
    pullRequestCount: 5,
  },
  topUsers: [
    {
      label: 'Ada Lovelace',
      pullRequestCount: 3,
    },
  ],
};

describe('managerStatsJob Slack ownership', () => {
  const destination = {
    provider: 'slack' as const,
    channelId: 'C-STATS',
    teamId: 'T-2',
    source: 'automation_target' as const,
  };
  const deployments = [
    { slackBotToken: 'token-wrong', slackTeamId: 'T-1', actorUserId: 'user-1' },
    { slackBotToken: 'token-owner', slackTeamId: 'T-2', actorUserId: 'user-2' },
  ];
  const postMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: async () => deployments }),
    } as never);
    const runtime = {
      enabled: true,
      scheduleMode: 'weekly',
      lastRunAt: null as Date | null,
    };
    vi.mocked(getAutomationRuntime).mockImplementation(
      async () => runtime as never,
    );
    vi.mocked(recordAutomationRunOutcome).mockImplementation(
      async (_db, outcome) => {
        runtime.lastRunAt = outcome.at ?? new Date();
      },
    );
    vi.mocked(resolveAutomationRuntimeDestination).mockResolvedValue(
      destination,
    );
    vi.mocked(isWeeklyRunDueOnLocalDay).mockImplementation(
      ({ lastRunAt }) => !lastRunAt,
    );
    vi.mocked(buildManagerStatsDigest).mockResolvedValue(stats as never);
    postMessage.mockResolvedValue('message-ts');
    vi.mocked(SlackNotifier).mockImplementation(function () {
      return { postMessage } as never;
    });
  });

  it.each([false, true])(
    'posts only with the owner token (manual=%s)',
    async (manualTrigger) => {
      const result = await managerStatsJob({
        manualTrigger,
        ...(manualTrigger ? { destination } : {}),
      });

      expect(result.completed).toBe(true);
      expect(result.errors).toEqual([]);
      expect(SlackNotifier).toHaveBeenCalledExactlyOnceWith('token-owner');
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C-STATS' }),
      );
      expect(buildManagerStatsDigest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ actorUserId: 'user-2' }),
      );
      expect(isWeeklyRunDueOnLocalDay).toHaveBeenCalledTimes(
        manualTrigger ? 0 : 1,
      );
      expect(recordAutomationRunOutcome).toHaveBeenCalledExactlyOnceWith(
        db,
        expect.objectContaining({ status: 'succeeded' }),
      );
    },
  );

  it.each([false, true])(
    'does not consume the interval when the owner is missing (manual=%s)',
    async (manualTrigger) => {
      vi.mocked(db.select).mockReturnValue({
        from: () => ({ where: async () => deployments.slice(0, 1) }),
      } as never);
      const result = await managerStatsJob({
        manualTrigger,
        ...(manualTrigger ? { destination } : {}),
      });

      expect(result.completed).toBe(false);
      expect(result.errors).toEqual([]);
      expect(isWeeklyRunDueOnLocalDay).not.toHaveBeenCalled();
      expect(buildManagerStatsDigest).not.toHaveBeenCalled();
      expect(SlackNotifier).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
      expect(recordAutomationRunOutcome).not.toHaveBeenCalled();
    },
  );

  it('preserves unbound Slack manual delivery to each installation', async () => {
    await managerStatsJob({
      manualTrigger: true,
      destination: {
        provider: 'slack',
        channelId: 'C-STATS',
        source: 'automation_target',
      },
    });
    expect(SlackNotifier).toHaveBeenNthCalledWith(1, 'token-wrong');
    expect(SlackNotifier).toHaveBeenNthCalledWith(2, 'token-owner');
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});

describe('formatManagerStatsMessage', () => {
  it('always includes the analytics link', () => {
    const message = formatManagerStatsMessage({
      stats,
    });

    expect(message.text).toContain(
      'https://app.example.com/analytics?object=pullRequests',
    );
  });

  it('formats the compact Roomote PR lines with merged subset stats', () => {
    const message = formatManagerStatsMessage({
      stats: {
        ...stats,
        activeUsers: 1234,
        roomotePullRequests: 2345,
        authoredPullRequests: 3456,
        reviewedPullRequests: 4567,
        totalPullRequests: 5678,
        mergedRoomotePullRequests: 1234,
        mostActiveRepo: {
          ...stats.mostActiveRepo,
          pullRequestCount: 6789,
        },
      },
    });

    expect(message.text).toContain('· Active users: *1,234*');
    expect(message.text).toContain(
      '· PRs opened with me: *2,345 (40% of 5,678)* — 3,456 authored, 4,567 reviewed',
    );
    expect(message.text).toContain(
      '· PR merged with me: *1,234 (67% of 3,456 authored)*',
    );
    expect(message.text).toContain(
      '· Most active repo: *acme/app* (6,789 PRs)',
    );
    expect(message.text).not.toContain('Share of total PRs');
  });

  it('includes the LOC line when all counted Roomote PRs are on GitHub', () => {
    const message = formatManagerStatsMessage({
      stats: { ...stats, additions: 1234, deletions: 5678 },
    });

    expect(message.text).toContain('· LOC added/removed: *+1,234 / -5,678*');
    expect(message.text).not.toContain('(GitHub PRs only)');
  });

  it('omits the LOC line entirely when non-GitHub Roomote PRs are counted', () => {
    const message = formatManagerStatsMessage({
      stats: { ...stats, locScope: 'github_only' as const },
    });

    expect(message.text).not.toContain('LOC added/removed');
  });

  it('formats counts for up to five top users', () => {
    const message = formatManagerStatsMessage({
      stats: {
        ...stats,
        topUsers: Array.from({ length: 5 }, (_, index) => ({
          label: `User ${index + 1}`,
          pullRequestCount: 1234 + index,
        })),
      },
    });

    expect(message.text).toContain(
      '· Top users: User 1 (1,234), User 2 (1,235), User 3 (1,236), User 4 (1,237), User 5 (1,238)',
    );
  });

  it('adds an automation-settings context footer', () => {
    const message = formatManagerStatsMessage({
      stats,
    });

    expect(message.blocks).toContainEqual({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Configure this in <https://app.example.com/automations#weekly-manager-stats|automation settings>.',
        },
      ],
    });
  });
});
