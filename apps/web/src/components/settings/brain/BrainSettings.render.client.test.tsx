import { fireEvent, render, screen } from '@testing-library/react';

import type { BrainSettings as BrainSettingsData } from '@/trpc/commands/brain';

const { state, navigation, mutations } = vi.hoisted(() => ({
  state: {
    query: {
      isPending: false,
      isError: false,
      data: null as BrainSettingsData | null,
    },
    searchParams: new URLSearchParams(),
    pageInputs: [] as Array<{ slug: string }>,
    listInputs: [] as Array<Record<string, unknown>>,
    pagePending: true,
  },
  navigation: {
    replace: vi.fn(),
  },
  mutations: {
    backfill: vi.fn(),
    retryFailed: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/memory',
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => state.searchParams,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previousData: unknown) => previousData,
  useQuery: (options: { queryKind?: string }) => {
    if (options.queryKind === 'list') {
      return {
        isPending: false,
        isError: false,
        data: {
          reachable: true,
          total: 1,
          nextOffset: null,
          pages: [
            {
              slug: 'tasks/run-9',
              title: 'Reworked the outbox drainer',
              namespaceId: 'tasks',
              namespaceLabel: 'Task memories',
              updatedAt: new Date('2026-01-02T00:00:00Z'),
            },
          ],
        },
      };
    }
    if (options.queryKind === 'page') {
      return { isPending: state.pagePending, isError: false, data: undefined };
    }
    return state.query;
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { mutationKind?: string }) =>
    options.mutationKind === 'retryFailed'
      ? { isPending: false, mutate: mutations.retryFailed }
      : options.mutationKind === 'setEnabled'
        ? { isPending: false, mutate: mutations.setEnabled }
        : { isPending: false, mutate: mutations.backfill },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    brain: {
      get: {
        queryOptions: () => ({ queryKind: 'settings' }),
        queryKey: () => ['brain', 'get'],
      },
      listPages: {
        queryOptions: (input: Record<string, unknown>) => {
          state.listInputs.push(input);
          return { queryKind: 'list' };
        },
      },
      getPage: {
        queryOptions: (input: { slug: string }) => {
          state.pageInputs.push(input);
          return { queryKind: 'page' };
        },
      },
      backfillTaskMemories: {
        mutationOptions: () => ({ mutationKind: 'backfill' }),
      },
      retryFailedTaskMemories: {
        mutationOptions: () => ({ mutationKind: 'retryFailed' }),
      },
      setMemoryEnabled: {
        mutationOptions: () => ({ mutationKind: 'setEnabled' }),
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
    enabled: true,
    enabledFromLegacyKey: false,
    url: 'http://gbrain:8080',
    inferenceProvider: 'openrouter',
    keySource: 'brain',
    recall: { mode: 'semantic', embeddedCount: 771, chunkCount: 771 },
    models: {
      synthesisModel: 'openai/gpt-5.6-luna',
      synthesisSource: 'default',
      embeddingModel: 'openai/text-embedding-3-small',
      embeddingDimensions: 1536,
    },
    corpus: {
      reachable: true,
      listedPages: 30,
      totalPages: null,
      namespaces: [
        { id: 'slack', label: 'Slack', pages: 20 },
        { id: 'tasks', label: 'Task memories', pages: 10 },
      ],
      activityByDay: [
        { date: '2026-01-01', pages: 12 },
        { date: '2026-01-02', pages: 6 },
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
        streams: 4,
        backfillProgress: null,
        trackedItems: 0,
      },
      {
        id: 'notion-pages',
        label: 'Notion',
        description: 'Pages the Notion integration can reach.',
        namespaceLabel: 'Notion',
        status: 'not_connected',
        lastSyncedAt: null,
        streams: 0,
        backfillProgress: null,
        trackedItems: 0,
      },
    ],
    taskMemories: {
      byStatus: { pending: 2, processing: 0, done: 8, skipped: 1, failed: 0 },
      total: 11,
      lastProcessedAt: new Date('2026-01-02T00:00:00Z'),
      lastError: null,
      historicalCompletedRunsWithoutEvent: 0,
      recentCompletedRunsWithoutEvent: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  state.query = { isPending: false, isError: false, data: buildSettings() };
  state.searchParams = new URLSearchParams();
  state.pageInputs.length = 0;
  state.listInputs.length = 0;
  state.pagePending = true;
  navigation.replace.mockClear();
  mutations.backfill.mockClear();
  mutations.retryFailed.mockClear();
  mutations.setEnabled.mockClear();
});

describe('BrainSettings', () => {
  it('shows Memory stats, the embedded browser, sources, and configuration', () => {
    render(<BrainSettings />);

    expect(screen.getAllByText('Connected')).toHaveLength(1);
    expect(screen.queryByText('Endpoint')).not.toBeInTheDocument();
    expect(screen.queryByText('http://gbrain:8080')).not.toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
    expect(screen.getByText('Semantic + keyword')).toBeInTheDocument();

    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByText('openai/gpt-5.6-luna')).toBeInTheDocument();
    expect(
      screen.getByText('openai/text-embedding-3-small'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Manage in Models')).not.toBeInTheDocument();

    expect(screen.getByText('Memory Stats')).toBeInTheDocument();
    expect(screen.getByText('30 memories')).toBeInTheDocument();
    expect(screen.getByText('Explore memories')).toBeInTheDocument();
    expect(
      screen.getByText('Memory activity (past 30 days)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reworked the outbox drainer')).toBeInTheDocument();

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.queryByText('1 of 2 connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Ingesting')).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'Connected' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Last read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/streams/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();

    expect(
      screen.queryByRole('heading', { name: 'Task memories' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Memory issues')).not.toBeInTheDocument();

    const memoryStats = screen.getByText('Memory Stats');
    const browser = screen.getByText('Explore memories');
    const configuration = screen.getByText('Configuration');
    expect(memoryStats.compareDocumentPosition(browser)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(browser.compareDocumentPosition(configuration)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('puts actionable memory issues first and keeps their repair controls', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      taskMemories: {
        ...settings.taskMemories,
        byStatus: { ...settings.taskMemories.byStatus, failed: 2 },
        recentCompletedRunsWithoutEvent: 3,
        lastError: 'Memory service unavailable',
      },
    };

    render(<BrainSettings />);

    const issues = screen.getByText('Memory issues');
    const stats = screen.getByText('Memory Stats');
    expect(issues.compareDocumentPosition(stats)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByText('Memory service unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Queue missing memories'));
    fireEvent.click(screen.getByText('Retry failed'));
    expect(mutations.backfill).toHaveBeenCalledOnce();
    expect(mutations.retryFailed).toHaveBeenCalledOnce();
  });

  it('selects browsed memories with URL replace semantics', () => {
    render(<BrainSettings />);
    fireEvent.click(screen.getByText('Reworked the outbox drainer'));

    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/settings/memory?memory=tasks%2Frun-9',
      { scroll: false },
    );
  });

  it('filters Explore memories when a stats category is selected', () => {
    render(<BrainSettings />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Filter Explore memories by Slack',
      }),
    );

    expect(state.listInputs.at(-1)).toMatchObject({ namespaceId: 'slack' });
  });

  it('keeps the activity chart visible for a newly active corpus', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      corpus: {
        ...settings.corpus,
        activityByDay: [
          { date: '2026-01-01', pages: 0 },
          { date: '2026-01-02', pages: 4 },
        ],
      },
    };

    render(<BrainSettings />);

    expect(
      screen.getByRole('img', { name: 'Memory activity chart' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ingestion started/)).not.toBeInTheDocument();
  });

  it('opens a directly linked memory from the query parameter', () => {
    state.searchParams = new URLSearchParams('memory=tasks%2Fdirect-run');
    state.pagePending = false;

    render(<BrainSettings />);

    expect(state.pageInputs).toContainEqual({ slug: 'tasks/direct-run' });
    expect(screen.getByText('Memory unavailable')).toBeInTheDocument();
  });

  it('reports an unreachable corpus without claiming the Brain is empty', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      status: 'unreachable',
      statusDetail: 'Memory did not answer.',
      corpus: {
        reachable: false,
        listedPages: 0,
        totalPages: null,
        namespaces: [],
        activityByDay: [],
      },
    };

    render(<BrainSettings />);

    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText('Corpus unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Nothing collected yet')).not.toBeInTheDocument();
  });

  it('prefers measured recall over provider inference', () => {
    const settings = buildSettings();
    state.query.data = {
      ...settings,
      recall: { mode: 'keyword-only', embeddedCount: 0, chunkCount: 771 },
      corpus: { ...settings.corpus, totalPages: 625 },
    };

    render(<BrainSettings />);

    // Measured keyword-only wins over the provider-presence inference, which
    // would have said semantic here (an OpenRouter provider resolves).
    expect(screen.getByText('Keyword only')).toBeInTheDocument();
    expect(screen.queryByText('Semantic + keyword')).not.toBeInTheDocument();
  });

  it('omits source badges and disconnected sources', () => {
    render(<BrainSettings />);

    // The stats legend and browser filter keep the Slack label; source cards
    // have no namespace badge.
    expect(screen.getAllByText('Slack')).toHaveLength(2);
    // Disconnected sources are omitted from the list entirely.
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();
  });

  it('shows only the toggle and its explanation while Memory is disabled', () => {
    state.query.data = buildSettings({
      enabled: false,
      status: 'not_configured',
      statusDetail: 'Memory is turned off for this deployment.',
    });

    render(<BrainSettings />);

    expect(
      screen.getByRole('switch', { name: 'Enable Memory' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Memory is off/)).toBeInTheDocument();
    expect(screen.queryByText('Memory Stats')).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Memory' }));
    expect(mutations.setEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it('notes when enablement still comes from the legacy provider key', () => {
    state.query.data = buildSettings({ enabledFromLegacyKey: true });

    render(<BrainSettings />);

    expect(
      screen.getByText(/enabled by a configured Memory provider key/),
    ).toBeInTheDocument();
  });

  it('stops at the explanation on a deployment with no Brain', () => {
    state.query.data = buildSettings({
      status: 'not_configured',
      statusDetail: 'Memory is not configured for this deployment.',
    });

    render(<BrainSettings />);

    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(
      screen.getByText('Memory is not configured for this deployment.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Memory Stats')).not.toBeInTheDocument();
    expect(screen.queryByText('Task memories')).not.toBeInTheDocument();
  });
});
