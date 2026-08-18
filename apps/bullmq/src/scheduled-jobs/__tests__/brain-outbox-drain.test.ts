import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveConnection,
  mockResolveBrainProvider,
  mockBackfillEvents,
  mockClaimEvents,
  mockGetSyncState,
  mockPullRequestFacts,
  mockRunBrainCollectors,
} = vi.hoisted(() => ({
  mockResolveConnection: vi.fn(),
  mockResolveBrainProvider: vi.fn(),
  mockBackfillEvents: vi.fn(),
  mockClaimEvents: vi.fn(),
  mockGetSyncState: vi.fn(),
  mockPullRequestFacts: vi.fn(),
  mockRunBrainCollectors: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: mockResolveConnection,
  resolveBrainInferenceProvider: mockResolveBrainProvider,
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit: mockPullRequestFacts })),
          })),
        })),
      })),
    },
    backfillBrainMemoryEvents: mockBackfillEvents,
    claimPendingBrainMemoryEvents: mockClaimEvents,
    getBrainSyncState: mockGetSyncState,
    upsertBrainSyncState: vi.fn(),
  };
});

vi.mock('../brain-collectors', () => ({
  runBrainCollectors: mockRunBrainCollectors,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSyncState.mockResolvedValue(null);
  mockClaimEvents.mockResolvedValue([]);
  mockPullRequestFacts.mockResolvedValue([]);
  mockRunBrainCollectors.mockResolvedValue({
    backfillProgressed: false,
    interrupted: false,
  });
});

import {
  brainCollectorsJob,
  brainOutboxDrainJob,
  buildPullRequestFactPage,
  buildMemoryPage,
  callBrainWriteTool,
  drainBrainHistoricalIngestion,
  getPullRequestFactsResumeCursor,
  isBrainNotReady,
  isBrainRateLimited,
  postToBrain,
  redactBrainText,
} from '../brain-outbox-drain';

describe('PR fact resume cursor', () => {
  const state = {
    watermark: new Date('2026-08-14T10:00:00Z'),
    backfillCursor: JSON.stringify({
      updatedAt: '2026-08-14T10:00:00.000Z',
      id: '00000000-0000-0000-0000-000000000042',
    }),
  };

  it('re-reads an overlap window at the start of a scheduled scan', () => {
    expect(getPullRequestFactsResumeCursor(state, true)).toEqual({
      updatedAt: new Date('2026-08-13T10:00:00.000Z'),
      id: null,
    });
  });

  it('keeps the exact tuple cursor within fast continuation', () => {
    expect(getPullRequestFactsResumeCursor(state, false)).toEqual({
      updatedAt: new Date('2026-08-14T10:00:00.000Z'),
      id: '00000000-0000-0000-0000-000000000042',
    });
  });
});

describe('pull request fact pages', () => {
  it('uses the merge occurrence instead of later remote updates', () => {
    const page = buildPullRequestFactPage({
      repositoryFullName: 'owner/repo',
      prNumber: 42,
      title: 'Ship it',
      htmlUrl: 'https://example.test/owner/repo/pull/42',
      authorLogin: 'octocat',
      state: 'merged',
      createdAtRemote: new Date('2026-08-01T09:00:00Z'),
      closedAtRemote: new Date('2026-08-14T10:00:00Z'),
      mergedAtRemote: new Date('2026-08-14T10:00:00Z'),
    });

    expect(page.content).toContain('\nevent_date: 2026-08-14\n');
    expect(page.content).toContain('\nmerged_at: 2026-08-14T10:00:00.000Z\n');
  });

  it('uses close then creation dates for unmerged pull requests', () => {
    const base = {
      repositoryFullName: 'owner/repo',
      prNumber: 42,
      title: 'Ship it',
      htmlUrl: 'https://example.test/owner/repo/pull/42',
      authorLogin: 'octocat',
      createdAtRemote: new Date('2026-08-01T09:00:00Z'),
      mergedAtRemote: null,
    };

    expect(
      buildPullRequestFactPage({
        ...base,
        state: 'closed',
        closedAtRemote: new Date('2026-08-09T10:00:00Z'),
      }).content,
    ).toContain('\nevent_date: 2026-08-09\n');
    expect(
      buildPullRequestFactPage({
        ...base,
        state: 'open',
        closedAtRemote: null,
      }).content,
    ).toContain('\nevent_date: 2026-08-01\n');
  });
});

describe('collector continuation orchestration', () => {
  beforeEach(() => {
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'ingest-token',
    });
    mockResolveBrainProvider.mockResolvedValue({
      providerId: 'openrouter',
      apiKey: 'sk-or',
    });
  });

  it('runs incremental integrations only on the scheduled pass', async () => {
    vi.useFakeTimers();
    mockRunBrainCollectors
      .mockResolvedValueOnce({
        backfillProgressed: true,
        interrupted: false,
      })
      .mockResolvedValueOnce({
        backfillProgressed: false,
        interrupted: false,
      });

    try {
      const job = brainCollectorsJob();
      await vi.runAllTimersAsync();
      await job;
    } finally {
      vi.useRealTimers();
    }

    expect(mockRunBrainCollectors).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { includeIncremental: true },
    );
    expect(mockRunBrainCollectors).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { includeIncremental: false },
    );
  });

  it('stops before collectors when PR-fact ingestion hits Brain backpressure', async () => {
    mockPullRequestFacts.mockResolvedValue([
      {
        id: 'pr-fact-1',
        repositoryFullName: 'owner/repo',
        prNumber: 42,
        title: 'Ship it',
        htmlUrl: 'https://example.test/owner/repo/pull/42',
        authorLogin: 'octocat',
        state: 'merged',
        createdAtRemote: new Date('2026-08-13T10:00:00Z'),
        closedAtRemote: new Date('2026-08-14T10:00:00Z'),
        mergedAtRemote: new Date('2026-08-14T10:00:00Z'),
        updatedAt: new Date('2026-08-14T11:00:00Z'),
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );

    try {
      await brainCollectorsJob();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(mockRunBrainCollectors).not.toHaveBeenCalled();
  });
});

describe('historical ingestion continuation', () => {
  it('keeps running bounded passes while backfill makes progress', async () => {
    const runPass = vi
      .fn()
      .mockResolvedValueOnce({ progressed: true, interrupted: false })
      .mockResolvedValueOnce({ progressed: true, interrupted: false })
      .mockResolvedValueOnce({ progressed: false, interrupted: false });
    const wait = vi.fn(async () => {});

    await drainBrainHistoricalIngestion({ runPass, wait });

    expect(runPass).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on Brain backpressure', async () => {
    const runPass = vi
      .fn()
      .mockResolvedValue({ progressed: true, interrupted: true });
    const wait = vi.fn(async () => {});

    await drainBrainHistoricalIngestion({ runPass, wait });

    expect(runPass).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('task memory page identity', () => {
  const base = {
    taskId: 'task-1',
    taskTitle: 'Remember the fix',
    completedAt: new Date('2026-08-13T10:00:00Z'),
    environmentName: null,
    agentSummary: 'Used the durable approach.',
    pullRequests: [],
  };

  it('keeps separate runs of the same task distinct', () => {
    const first = buildMemoryPage({ ...base, runId: 101 });
    const followUp = buildMemoryPage({ ...base, runId: 102 });

    expect(first.slug).toBe('tasks/task-1/runs/101');
    expect(followUp.slug).toBe('tasks/task-1/runs/102');
  });

  it('dates live and backfilled memories by task completion', () => {
    const page = buildMemoryPage({ ...base, runId: 101 });

    expect(page.content).toContain('\ndate: 2026-08-13\n');
    expect(page.content).toContain(
      '\ncompleted_at: 2026-08-13T10:00:00.000Z\n',
    );
  });

  it('does not emit an invalid date when legacy completion time is missing', () => {
    const page = buildMemoryPage({
      ...base,
      completedAt: null,
      runId: 101,
    });

    expect(page.content).not.toContain('\ndate:');
    expect(page.content).toContain('\ncompleted_at: unknown\n');
  });
});

describe('redactBrainText', () => {
  it.each([
    ['GitHub PAT', 'token ghp_abcdefghijklmnopqrstuvwxyz012345 here'],
    ['fine-grained PAT', 'github_pat_11ABCDEFG_abcdefghijklmnopqrst end'],
    ['OpenAI-style key', 'key sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['Slack token', 'xoxb-1234567890-abcdefghijk'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['bearer header', 'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz'],
  ])('redacts %s', (_label, input) => {
    const output = redactBrainText(input);

    expect(output).toContain('[REDACTED]');
  });

  it('redacts PEM private key blocks including contents', () => {
    const input = [
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n');

    const output = redactBrainText(input);

    expect(output).not.toContain('MIIEpAIBAAKCAQEA7');
    expect(output).toContain('before');
    expect(output).toContain('after');
  });

  it('leaves ordinary prose and identifiers alone', () => {
    const input =
      'Completed task tasks/abc123: merged owner/repo#42 at 2026-08-13.';

    expect(redactBrainText(input)).toBe(input);
  });
});

describe('postToBrain failure classification', () => {
  const connection = { baseUrl: 'http://brain.test', token: 'ingest-token' };
  const page = { slug: 'tasks/abc', title: 'A task', content: '# A task' };

  function stubUpstream(body: string, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a Brain that cannot embed as not-ready, not a bad page', async () => {
    // Exactly what gbrain returns when its embedding provider is unreachable.
    // Counting this against the page would burn its retry budget and bury a
    // good memory in a terminal state that no later claim picks up.
    stubUpstream(
      JSON.stringify({
        result: {
          content: [
            {
              type: 'text',
              text: '{"error":"internal_error","message":"[embed(openai:text-embedding-3-small)] Failed after 3 attempts. Last error: Service Unavailable"}',
            },
          ],
          isError: true,
        },
      }),
    );

    await expect(postToBrain(page, connection)).rejects.toSatisfy(
      isBrainNotReady,
    );
  });

  it('still reports an ordinary rejection as a plain failure', async () => {
    stubUpstream(
      JSON.stringify({
        result: {
          content: [{ type: 'text', text: '{"error":"bad_slug"}' }],
          isError: true,
        },
      }),
    );

    const error = await postToBrain(page, connection).catch((e) => e);

    expect(isBrainNotReady(error)).toBe(false);
    expect(isBrainRateLimited(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });

  it('reports a 429 as backpressure', async () => {
    stubUpstream('rate limited', 429);

    await expect(postToBrain(page, connection)).rejects.toSatisfy(
      isBrainRateLimited,
    );
  });

  it('calls supported gbrain write operations with the ingest credential', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await callBrainWriteTool(connection, 'add_timeline_entry', {
      slug: 'people/member-a',
      date: '2026-08-18',
      summary: 'Participated in #general',
      source: 'slack/team/channel/batch',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://brain.test/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer ingest-token',
        }),
        body: expect.stringContaining('"name":"add_timeline_entry"'),
      }),
    );
  });
});

describe('Brain readiness gate', () => {
  it('does nothing at all until a model provider is configured', async () => {
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'ingest-token',
    });
    // A Brain container exists and provisioning succeeded, but nobody has
    // configured a provider yet. Draining now would post pages the Brain
    // cannot embed, burn every memory through its retry budget into a
    // terminal state, and mark the one-shot history backfill complete before
    // a single page landed.
    mockResolveBrainProvider.mockResolvedValue(null);

    await brainOutboxDrainJob();

    expect(mockBackfillEvents).not.toHaveBeenCalled();
    expect(mockClaimEvents).not.toHaveBeenCalled();
  });

  it('drains once a provider is configured', async () => {
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'ingest-token',
    });
    mockResolveBrainProvider.mockResolvedValue({
      providerId: 'openrouter',
      apiKey: 'sk-or',
    });
    mockGetSyncState.mockResolvedValue({ backfillCompletedAt: new Date() });
    mockClaimEvents.mockResolvedValue([]);

    await brainOutboxDrainJob();

    expect(mockClaimEvents).toHaveBeenCalled();
  });
});
