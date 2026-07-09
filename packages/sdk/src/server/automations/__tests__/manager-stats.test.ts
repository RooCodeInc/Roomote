vi.mock('@roomote/env', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://app.example.com',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  githubInstallations: {},
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

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('../scheduling-utils', () => ({
  isWeeklyRunDueOnLocalDay: vi.fn(),
  resolveSlackWorkspaceTimezone: vi.fn(),
}));

import { formatManagerStatsMessage } from '../manager-stats';

const stats = {
  activeUsers: 3,
  roomotePullRequests: 4,
  roomotePullRequestPercentage: 40,
  totalPullRequests: 10,
  mergedRoomotePullRequests: 2,
  mergedRoomotePullRequestPercentage: 50,
  additions: 123,
  deletions: 45,
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

describe('formatManagerStatsMessage', () => {
  it('always includes the analytics link', () => {
    const message = formatManagerStatsMessage({
      stats,
    });

    expect(message.text).toContain('https://app.example.com/analytics');
  });

  it('formats the compact Roomote PR lines with merged subset stats', () => {
    const message = formatManagerStatsMessage({
      stats,
    });

    expect(message.text).toContain('· PRs opened with me: *4 (40% of 10)*');
    expect(message.text).toContain('· PR merged with me: *2 (50% of 4)*');
    expect(message.text).not.toContain('Share of total PRs');
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
