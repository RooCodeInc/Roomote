import { fireEvent, render, screen } from '@testing-library/react';

import type { BrainSettings as BrainSettingsData } from '@/trpc/commands/brain';

const { state, mutations } = vi.hoisted(() => ({
  state: {
    query: {
      isPending: false,
      isError: false,
      data: null as BrainSettingsData | null,
    },
  },
  mutations: {
    backfill: vi.fn(),
    retryFailed: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { mutationKind?: string }) =>
    options.mutationKind === 'retryFailed'
      ? { isPending: false, mutate: mutations.retryFailed }
      : { isPending: false, mutate: mutations.backfill },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    brain: {
      get: {
        queryOptions: () => ({ queryKey: ['brain', 'get'] }),
        queryKey: () => ['brain', 'get'],
      },
      backfillTaskMemories: {
        mutationOptions: () => ({ mutationKind: 'backfill' }),
      },
      retryFailedTaskMemories: {
        mutationOptions: () => ({ mutationKind: 'retryFailed' }),
      },
    },
  }),
}));

const { BrainSettings } = await import('./BrainSettings');

function buildSettings(
  overrides: Partial<BrainSettingsData> = {},
): BrainSettingsData {
  return {
    status: 'connected',
    statusDetail: null,
    url: 'http://gbrain:8080',
    inferenceProvider: 'openrouter',
    corpus: {
      reachable: true,
      sampledPages: 30,
      truncated: false,
      namespaces: [
        { id: 'slack', label: 'Slack', pages: 20 },
        { id: 'tasks', label: 'Task memories', pages: 10 },
      ],
      recentPages: [
        {
          slug: 'tasks/run-9',
          title: 'Reworked the outbox drainer',
          namespaceLabel: 'Task memories',
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        },
      ],
    },
    sources: [
      {
        id: 'slack-public-channels',
        label: 'Slack public channels',
        description: 'Public channel history.',
        namespaceLabel: 'Slack',
        status: 'ingesting',
        lastSyncedAt: new Date('2026-01-02T00:00:00Z'),
        partitions: 4,
        partitionsBackfilled: 4,
        trackedItems: 0,
      },
      {
        id: 'notion-pages',
        label: 'Notion',
        description: 'Pages the Notion integration can reach.',
        namespaceLabel: 'Notion',
        status: 'not_connected',
        lastSyncedAt: null,
        partitions: 0,
        partitionsBackfilled: 0,
        trackedItems: 0,
      },
    ],
    taskMemories: {
      byStatus: { pending: 2, processing: 0, done: 8, skipped: 1, failed: 0 },
      total: 11,
      lastProcessedAt: new Date('2026-01-02T00:00:00Z'),
      lastError: null,
      completedRunsWithoutEvent: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  state.query = { isPending: false, isError: false, data: buildSettings() };
  mutations.backfill.mockClear();
  mutations.retryFailed.mockClear();
});

describe('BrainSettings', () => {
  it('shows what the Brain holds, where it learns from, and what it recorded', () => {
    render(<BrainSettings />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('http://gbrain:8080')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();

    expect(screen.getByText('What the Brain knows')).toBeInTheDocument();
    expect(screen.getByText('30 pages')).toBeInTheDocument();
    expect(screen.getByText('Reworked the outbox drainer')).toBeInTheDocument();

    expect(screen.getByText('1 of 2 connected')).toBeInTheDocument();
    expect(screen.getByText('Ingesting')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();

    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('says the corpus is a recent sample rather than a total when it is', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      corpus: { ...settings.corpus, truncated: true },
    };

    render(<BrainSettings />);

    expect(screen.getByText('30 most recent pages')).toBeInTheDocument();
    expect(
      screen.getByText(/describes what it has learned lately/),
    ).toBeInTheDocument();
  });

  it('offers to ingest history only when completed tasks are missing a memory', () => {
    render(<BrainSettings />);
    expect(screen.queryByText('Ingest task history')).not.toBeInTheDocument();

    const settings = buildSettings();
    state.query.data = {
      ...settings,
      taskMemories: { ...settings.taskMemories, completedRunsWithoutEvent: 12 },
    };

    render(<BrainSettings />);

    fireEvent.click(screen.getByText('Ingest task history'));
    expect(mutations.backfill).toHaveBeenCalled();
  });

  it('surfaces the failing error next to the retry it explains', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      taskMemories: {
        ...settings.taskMemories,
        byStatus: { ...settings.taskMemories.byStatus, failed: 3 },
        lastError: 'gbrain put_page failed: 503',
      },
    };

    render(<BrainSettings />);

    expect(screen.getByText('gbrain put_page failed: 503')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry failed'));
    expect(mutations.retryFailed).toHaveBeenCalled();
  });

  it('reports an unreachable corpus without claiming the Brain is empty', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      status: 'unreachable',
      statusDetail: 'The Brain did not answer.',
      corpus: {
        reachable: false,
        sampledPages: 0,
        truncated: false,
        namespaces: [],
        recentPages: [],
      },
    };

    render(<BrainSettings />);

    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText('Corpus unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Nothing collected yet')).not.toBeInTheDocument();
  });

  it('stops at the explanation on a deployment with no Brain', () => {
    state.query.data = buildSettings({
      status: 'not_configured',
      statusDetail: 'This deployment has no Brain.',
    });

    render(<BrainSettings />);

    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(
      screen.getByText('This deployment has no Brain.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('What the Brain knows')).not.toBeInTheDocument();
    expect(screen.queryByText('Task memories')).not.toBeInTheDocument();
  });
});
