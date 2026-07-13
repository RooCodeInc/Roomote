// pnpm --filter @roomote/api test src/handlers/github/__tests__/handlePrMerge.test.ts

vi.mock('../notifySlackPrMerge', () => ({
  notifySlackPrMerge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../notifyTeamsPrMerge', () => ({
  notifyTeamsPrMerge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../notifyTelegramAndLinearPrMerge', () => ({
  notifyTelegramAndLinearPrMerge: vi.fn().mockResolvedValue(undefined),
}));

import { handlePrMerge } from '../handlePrMerge';
import { notifySlackPrMerge } from '../notifySlackPrMerge';
import { notifyTeamsPrMerge } from '../notifyTeamsPrMerge';
import { notifyTelegramAndLinearPrMerge } from '../notifyTelegramAndLinearPrMerge';

import type { WebhookPullRequestClosed } from '../types';

const mockedNotifySlackPrMerge = vi.mocked(notifySlackPrMerge);
const mockedNotifyTeamsPrMerge = vi.mocked(notifyTeamsPrMerge);
const mockedNotifyTelegramAndLinearPrMerge = vi.mocked(
  notifyTelegramAndLinearPrMerge,
);

function makePayload(
  overrides: Partial<{
    merged: boolean;
    merged_at: string | null;
    installationId: number | null;
  }> = {},
): WebhookPullRequestClosed {
  const merged = overrides.merged ?? true;
  const merged_at =
    overrides.merged_at ?? (merged ? '2026-01-01T00:00:00Z' : null);
  const installationId =
    'installationId' in overrides ? overrides.installationId : 12345;

  return {
    installation: installationId ? { id: installationId } : undefined,
    repository: {
      id: 1,
      full_name: 'owner/repo',
      name: 'repo',
      owner: { login: 'owner' },
    },
    pull_request: {
      number: 42,
      title: 'Test PR',
      html_url: 'https://github.com/owner/repo/pull/42',
      merged,
      merged_at,
      merge_commit_sha: 'abc123',
      head: { sha: 'head123', ref: 'feature-branch' },
      base: { ref: 'main' },
      user: { login: 'author' },
      merged_by: { login: 'merger' },
      draft: false,
    },
    sender: { login: 'sender-user' },
  } as unknown as WebhookPullRequestClosed;
}

describe('handlePrMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notifies Slack, Teams, and Telegram/Linear for closed PRs', async () => {
    const payload = makePayload({ merged: false, merged_at: null });

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    const expectedParams = {
      sourceControlProvider: 'github',
      installationId: 12345,
      repository: 'owner/repo',
      prNumber: 42,
      prTitle: 'Test PR',
      prUrl: 'https://github.com/owner/repo/pull/42',
      status: 'closed',
      actorLogin: 'sender-user',
    };
    expect(mockedNotifySlackPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockedNotifyTeamsPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockedNotifyTelegramAndLinearPrMerge).toHaveBeenCalledWith({
      ...expectedParams,
      sourceControlProvider: 'github',
    });
  });

  it('notifies Slack, Teams, and Telegram/Linear for merged PRs', async () => {
    const payload = makePayload();

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    const expectedParams = {
      sourceControlProvider: 'github',
      installationId: 12345,
      repository: 'owner/repo',
      prNumber: 42,
      prTitle: 'Test PR',
      prUrl: 'https://github.com/owner/repo/pull/42',
      status: 'merged',
      actorLogin: 'merger',
    };
    expect(mockedNotifySlackPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockedNotifyTeamsPrMerge).toHaveBeenCalledWith(expectedParams);
    expect(mockedNotifyTelegramAndLinearPrMerge).toHaveBeenCalledWith({
      ...expectedParams,
      sourceControlProvider: 'github',
    });
  });

  it('does not notify Slack when installation is missing', async () => {
    const payload = makePayload({ installationId: null });

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    expect(mockedNotifySlackPrMerge).not.toHaveBeenCalled();
    expect(mockedNotifyTeamsPrMerge).not.toHaveBeenCalled();
    expect(mockedNotifyTelegramAndLinearPrMerge).not.toHaveBeenCalled();
  });

  it('does not throw when notifySlackPrMerge rejects', async () => {
    mockedNotifySlackPrMerge.mockRejectedValue(new Error('Slack is down'));

    const payload = makePayload();

    // Should not throw because the notification is fire-and-forget
    const result = await handlePrMerge(payload);
    expect(result.status).toBe('ok');
  });

  it('does not throw when notifyTeamsPrMerge rejects', async () => {
    mockedNotifyTeamsPrMerge.mockRejectedValue(new Error('Teams is down'));

    const payload = makePayload();

    // Should not throw because the notification is fire-and-forget
    const result = await handlePrMerge(payload);
    expect(result.status).toBe('ok');
  });
});
