const {
  mockMarkTaskPullRequestTerminal,
  mockRepositoriesFindFirst,
  mockNotifySlackPrMerge,
  mockNotifyTeamsPrMerge,
  mockNotifyTelegramAndLinearPrMerge,
} = vi.hoisted(() => ({
  mockMarkTaskPullRequestTerminal: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockNotifySlackPrMerge: vi.fn(),
  mockNotifyTeamsPrMerge: vi.fn(),
  mockNotifyTelegramAndLinearPrMerge: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  markTaskPullRequestTerminal: mockMarkTaskPullRequestTerminal,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findFirst: (...args: unknown[]) => mockRepositoriesFindFirst(...args),
      },
    },
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  findActiveGitHubPrReviewTask: vi.fn(),
}));

vi.mock('../../github/notifySlackPrMerge', () => ({
  notifySlackPrMerge: mockNotifySlackPrMerge,
}));

vi.mock('../../github/notifyTeamsPrMerge', () => ({
  notifyTeamsPrMerge: mockNotifyTeamsPrMerge,
}));

vi.mock('../../github/notifyTelegramAndLinearPrMerge', () => ({
  notifyTelegramAndLinearPrMerge: mockNotifyTelegramAndLinearPrMerge,
}));

import { handleBitbucketPullRequest } from '../handlePullRequest';
import type { BitbucketPullRequestWebhook } from '../types';

function makePayload(
  overrides: Partial<BitbucketPullRequestWebhook['pullrequest']> = {},
): BitbucketPullRequestWebhook {
  return {
    actor: { uuid: '{user-1}', nickname: 'roomote-bot' },
    repository: {
      uuid: '{repo-1}',
      full_name: 'acme/backend',
    },
    pullrequest: {
      id: 42,
      title: 'Update backend',
      state: 'OPEN',
      links: {
        html: {
          href: 'https://bitbucket.org/acme/backend/pull-requests/42',
        },
      },
      source: {
        branch: { name: 'feature/test' },
        commit: { hash: 'abc123' },
      },
      destination: {
        branch: { name: 'main' },
        commit: { hash: 'def456' },
      },
      ...overrides,
    },
  };
}

describe('handleBitbucketPullRequest terminal status', () => {
  beforeEach(() => {
    mockMarkTaskPullRequestTerminal.mockReset();
    mockRepositoriesFindFirst.mockReset();
    mockNotifySlackPrMerge.mockReset();
    mockNotifyTeamsPrMerge.mockReset();
    mockNotifyTelegramAndLinearPrMerge.mockReset();

    mockMarkTaskPullRequestTerminal.mockResolvedValue(undefined);
    mockRepositoriesFindFirst.mockResolvedValue({ id: 'repo-row-1' });
    mockNotifySlackPrMerge.mockResolvedValue(undefined);
    mockNotifyTeamsPrMerge.mockResolvedValue(undefined);
    mockNotifyTelegramAndLinearPrMerge.mockResolvedValue(undefined);
  });

  it('marks fulfilled pull requests as merged via the terminal helper', async () => {
    await expect(
      handleBitbucketPullRequest(
        makePayload({ state: 'MERGED' }),
        'pullrequest:fulfilled',
      ),
    ).resolves.toEqual({ status: 'ok' });

    expect(mockMarkTaskPullRequestTerminal).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'bitbucket',
        repository: 'acme/backend',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://bitbucket.org/acme/backend/pull-requests/42',
        status: 'merged',
        actorLogin: 'roomote-bot',
      },
      { logLabel: 'handleBitbucketPullRequest' },
    );
    expect(mockNotifySlackPrMerge).toHaveBeenCalled();
  });

  it('marks rejected pull requests as closed without merge notifications', async () => {
    await handleBitbucketPullRequest(
      makePayload({ state: 'DECLINED' }),
      'pullrequest:rejected',
    );

    expect(mockMarkTaskPullRequestTerminal).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'bitbucket',
        repository: 'acme/backend',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://bitbucket.org/acme/backend/pull-requests/42',
        status: 'closed',
        actorLogin: 'roomote-bot',
      },
      { logLabel: 'handleBitbucketPullRequest' },
    );
    expect(mockNotifySlackPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTeamsPrMerge).not.toHaveBeenCalled();
    expect(mockNotifyTelegramAndLinearPrMerge).not.toHaveBeenCalled();
  });
});
