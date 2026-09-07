import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpsertFact } = vi.hoisted(() => ({
  mockUpsertFact: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  upsertSourceControlPullRequestFactFromWebhook: mockUpsertFact,
}));

import {
  scheduleSourceControlPullRequestFactSync,
  toValidIsoString,
} from '../pull-request-fact-sync';

describe('scheduleSourceControlPullRequestFactSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertFact.mockResolvedValue(undefined);
  });

  it('forwards a description the webhook carried', () => {
    // Terminal webhooks advance the incremental cursor, so a PR whose
    // description is dropped here is never revisited by the list sync to
    // fill it in.
    scheduleSourceControlPullRequestFactSync({
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 42,
        title: 'Update backend',
        body: 'Why: the old path raced.',
        url: 'https://gitlab.example.com/acme/backend/-/merge_requests/42',
        state: 'merged',
        mergedAt: '2026-07-10T00:00:00Z',
      },
    });

    expect(mockUpsertFact).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequest: expect.objectContaining({
          body: 'Why: the old path raced.',
          // Labels are absent from every provider's PR webhook, so they stay
          // unknown and the upsert preserves whatever the list sync stored.
          labels: null,
        }),
      }),
    );
  });

  it('builds a merged fact snapshot from complete webhook timestamps', () => {
    scheduleSourceControlPullRequestFactSync({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 42,
        externalId: 900,
        title: 'Update backend',
        url: 'https://git.example.com/acme/backend/pulls/42',
        authorLogin: 'gitea-user',
        state: 'merged',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
        mergedAt: '2026-07-10T00:00:00Z',
      },
    });

    expect(mockUpsertFact).toHaveBeenCalledWith({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      host: 'git.example.com',
      pullRequest: {
        authorLogin: 'gitea-user',
        body: null,
        labels: null,
        closedAt: '2026-07-10T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        externalPullRequestId: 900,
        mergedAt: '2026-07-10T00:00:00.000Z',
        number: 42,
        state: 'merged',
        title: 'Update backend',
        updatedAt: '2026-07-10T00:00:00.000Z',
        url: 'https://git.example.com/acme/backend/pulls/42',
      },
    });
  });

  it('falls back through updatedAt for merges without a merge timestamp (Bitbucket)', () => {
    scheduleSourceControlPullRequestFactSync({
      provider: 'bitbucket',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 7,
        title: 'PR',
        url: 'https://bitbucket.org/acme/backend/pull-requests/7',
        state: 'merged',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    });

    const snapshot = mockUpsertFact.mock.calls[0]![0].pullRequest;
    expect(snapshot.mergedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(snapshot.closedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(snapshot.externalPullRequestId).toBe(7);
  });

  it('defaults every timestamp to the event time when the payload has none', () => {
    const before = Date.now();

    scheduleSourceControlPullRequestFactSync({
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 3,
        title: 'MR',
        url: 'https://gitlab.com/acme/backend/-/merge_requests/3',
        state: 'merged',
      },
    });

    const snapshot = mockUpsertFact.mock.calls[0]![0].pullRequest;
    const mergedAtMs = new Date(snapshot.mergedAt).getTime();
    expect(mergedAtMs).toBeGreaterThanOrEqual(before);
    expect(snapshot.updatedAt).toBe(snapshot.mergedAt);
    expect(snapshot.createdAt).toBe(snapshot.mergedAt);
    expect(snapshot.authorLogin).toBeNull();
  });

  it('leaves mergedAt null for closed-without-merge events', () => {
    scheduleSourceControlPullRequestFactSync({
      provider: 'ado',
      repositoryFullName: 'acme/Platform/backend',
      pullRequest: {
        number: 5,
        title: 'Abandoned PR',
        url: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/5',
        state: 'closed',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-10T00:00:00Z',
      },
    });

    const snapshot = mockUpsertFact.mock.calls[0]![0].pullRequest;
    expect(snapshot.state).toBe('closed');
    expect(snapshot.mergedAt).toBeNull();
    expect(snapshot.closedAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('scopes the upsert to the instance host taken from the PR URL', () => {
    scheduleSourceControlPullRequestFactSync({
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 9,
        title: 'MR',
        url: 'https://gitlab.internal.example.com:8443/acme/backend/-/merge_requests/9',
        state: 'merged',
      },
    });

    expect(mockUpsertFact.mock.calls[0]![0].host).toBe(
      'gitlab.internal.example.com:8443',
    );
  });

  it('passes a null host when the PR URL is relative or unparseable', () => {
    scheduleSourceControlPullRequestFactSync({
      provider: 'gitea',
      repositoryFullName: 'acme/backend',
      pullRequest: {
        number: 11,
        title: 'PR',
        url: '/pulls/11',
        state: 'merged',
      },
    });

    expect(mockUpsertFact.mock.calls[0]![0].host).toBeNull();
  });

  it('swallows upsert failures', async () => {
    mockUpsertFact.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      scheduleSourceControlPullRequestFactSync({
        provider: 'gitea',
        repositoryFullName: 'acme/backend',
        pullRequest: {
          number: 1,
          title: 'PR',
          url: 'https://git.example.com/acme/backend/pulls/1',
          state: 'merged',
        },
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});

describe('toValidIsoString', () => {
  it('normalizes ISO and GitLab-style timestamps', () => {
    expect(toValidIsoString('2026-07-10T00:00:00Z')).toBe(
      '2026-07-10T00:00:00.000Z',
    );
    expect(toValidIsoString('2026-07-10 12:34:56 UTC')).toBe(
      '2026-07-10T12:34:56.000Z',
    );
  });

  it('returns null for missing or unparseable values', () => {
    expect(toValidIsoString(null)).toBeNull();
    expect(toValidIsoString(undefined)).toBeNull();
    expect(toValidIsoString('not a date')).toBeNull();
  });
});
