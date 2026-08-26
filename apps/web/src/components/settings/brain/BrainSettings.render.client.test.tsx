import { fireEvent, render, screen } from '@testing-library/react';

import type { BrainSettings as BrainSettingsData } from '@/trpc/commands/brain';

const { state, navigation } = vi.hoisted(() => ({
  state: {
    query: {
      isPending: false,
      isError: false,
      data: null as BrainSettingsData | null,
    },
    searchParams: new URLSearchParams(),
    pageInputs: [] as Array<{ slug: string }>,
    pagePending: true,
  },
  navigation: {
    replace: vi.fn(),
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
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    brain: {
      get: {
        queryOptions: () => ({ queryKind: 'settings' }),
      },
      listPages: {
        queryOptions: () => ({ queryKind: 'list' }),
      },
      getPage: {
        queryOptions: (input: { slug: string }) => {
          state.pageInputs.push(input);
          return { queryKind: 'page' };
        },
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
  state.pagePending = true;
  navigation.replace.mockClear();
});

describe('BrainSettings', () => {
  it('shows Memory stats, the embedded browser, sources, and configuration', () => {
    render(<BrainSettings />);

    expect(screen.getAllByText('Connected')).toHaveLength(2);
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
    expect(screen.getByText('30 pages')).toBeInTheDocument();
    expect(screen.getByText('Browser memories')).toBeInTheDocument();
    expect(
      screen.getByText('Memory activity (past 30 days)'),
    ).toBeInTheDocument();
    expect(screen.getByText('New memories')).toBeInTheDocument();
    expect(screen.getAllByText('Reworked the outbox drainer')).toHaveLength(2);

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.queryByText('1 of 2 connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Ingesting')).not.toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();

    expect(
      screen.queryByRole('heading', { name: 'Task memories' }),
    ).not.toBeInTheDocument();

    const memoryStats = screen.getByText('Memory Stats');
    const browser = screen.getByText('Browser memories');
    const configuration = screen.getByText('Configuration');
    expect(memoryStats.compareDocumentPosition(browser)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(browser.compareDocumentPosition(configuration)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('selects recent and browsed memories with URL replace semantics', () => {
    render(<BrainSettings />);
    const rows = screen.getAllByText('Reworked the outbox drainer');
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);

    expect(navigation.replace).toHaveBeenCalledTimes(2);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/settings/memory?memory=tasks%2Frun-9',
      { scroll: false },
    );
  });

  it('opens a directly linked memory from the query parameter', () => {
    state.searchParams = new URLSearchParams('memory=tasks%2Fdirect-run');
    state.pagePending = false;

    render(<BrainSettings />);

    expect(state.pageInputs).toContainEqual({ slug: 'tasks/direct-run' });
    expect(screen.getByText('Page unavailable')).toBeInTheDocument();
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
        recentPages: [],
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

    // Only the composition legend keeps the Slack label; source cards have no
    // namespace badge.
    expect(screen.getAllByText('Slack')).toHaveLength(1);
    // Disconnected sources are omitted from the list entirely.
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();
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
