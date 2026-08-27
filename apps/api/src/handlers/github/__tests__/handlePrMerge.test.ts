// pnpm --filter @roomote/api test src/handlers/github/__tests__/handlePrMerge.test.ts

vi.mock('../notifyPullRequestTerminalStatus', () => ({
  scheduleNotifyPullRequestTerminalStatus: vi.fn(),
}));

import { handlePrMerge } from '../handlePrMerge';
import { scheduleNotifyPullRequestTerminalStatus } from '../notifyPullRequestTerminalStatus';

import type { WebhookPullRequestClosed } from '../types';

const mockedScheduleNotify = vi.mocked(scheduleNotifyPullRequestTerminalStatus);

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

  it('schedules terminal-status notification for closed PRs', async () => {
    const payload = makePayload({ merged: false, merged_at: null });

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    expect(mockedScheduleNotify).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'github',
        installationId: 12345,
        repository: 'owner/repo',
        host: 'github.com',
        prNumber: 42,
        prTitle: 'Test PR',
        prUrl: 'https://github.com/owner/repo/pull/42',
        status: 'closed',
        actorLogin: 'sender-user',
      },
      'PR #42',
    );
  });

  it('schedules terminal-status notification for merged PRs', async () => {
    const payload = makePayload();

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    expect(mockedScheduleNotify).toHaveBeenCalledWith(
      {
        sourceControlProvider: 'github',
        installationId: 12345,
        repository: 'owner/repo',
        host: 'github.com',
        prNumber: 42,
        prTitle: 'Test PR',
        prUrl: 'https://github.com/owner/repo/pull/42',
        status: 'merged',
        actorLogin: 'merger',
      },
      'PR #42',
    );
  });

  it('does not notify when installation is missing', async () => {
    const payload = makePayload({ installationId: null });

    const result = await handlePrMerge(payload);

    expect(result.status).toBe('ok');
    expect(mockedScheduleNotify).not.toHaveBeenCalled();
  });

  it('includes Fast parent targets when status recording failed', async () => {
    const payload = makePayload();

    await handlePrMerge(payload, { includeFastParentTargets: true });

    expect(mockedScheduleNotify).toHaveBeenCalledWith(
      expect.objectContaining({ includeFastParentTargets: true }),
      'PR #42',
    );
  });
});
