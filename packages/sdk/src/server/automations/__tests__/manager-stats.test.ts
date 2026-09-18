vi.mock('@roomote/env', () => ({
  Env: {
    R_APP_URL: 'https://app.example.com',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  githubInstallations: {},
  repositories: {},
  slackInstallations: {},
  getAutomationRuntime: vi.fn(),
  recordAutomationRunOutcome: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('../../lib/manager-slack', () => ({
  buildAutomationSettingsMessage: (
    text: string,
    hash: string,
    options?: { contentBlocks?: unknown[] },
  ) => ({
    text: text.trim(),
    blocks: [
      ...(options?.contentBlocks ?? [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: text.trim(),
          },
        },
      ]),
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
  formatManagerStatsMessage,
  hasManagerStatsActivity,
} from '../manager-stats';

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
  dailyPullRequestActivity: [
    { label: 'Sep 4', createdPullRequests: 0, mergedPullRequests: 1 },
    { label: 'Sep 5', createdPullRequests: 2, mergedPullRequests: 0 },
    { label: 'Sep 6', createdPullRequests: 0, mergedPullRequests: 0 },
    { label: 'Sep 7', createdPullRequests: 1, mergedPullRequests: 1 },
    { label: 'Sep 8', createdPullRequests: 0, mergedPullRequests: 0 },
    { label: 'Sep 9', createdPullRequests: 3, mergedPullRequests: 2 },
    { label: 'Sep 10', createdPullRequests: 1, mergedPullRequests: 0 },
  ],
};

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

  it('includes a native daily PR activity line chart without axis titles', () => {
    const message = formatManagerStatsMessage({ stats });

    expect(message.blocks).toContainEqual({
      type: 'data_visualization',
      title: 'Daily PR activity',
      chart: {
        type: 'line',
        series: [
          {
            name: 'Created PRs',
            data: stats.dailyPullRequestActivity.map((day) => ({
              label: day.label,
              value: day.createdPullRequests,
            })),
          },
          {
            name: 'Merged PRs',
            data: stats.dailyPullRequestActivity.map((day) => ({
              label: day.label,
              value: day.mergedPullRequests,
            })),
          },
        ],
        axis_config: {
          categories: stats.dailyPullRequestActivity.map((day) => day.label),
        },
      },
    });
  });
});

describe('hasManagerStatsActivity', () => {
  it('keeps a report with only an older PR merged during the window', () => {
    expect(
      hasManagerStatsActivity({
        ...stats,
        activeUsers: 0,
        totalPullRequests: 0,
        dailyPullRequestActivity: stats.dailyPullRequestActivity.map(
          (day, index) => ({
            ...day,
            createdPullRequests: 0,
            mergedPullRequests: index === 0 ? 1 : 0,
          }),
        ),
      }),
    ).toBe(true);
  });
});
