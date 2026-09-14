import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import type { ResultInboxItem } from '@/trpc/commands/results';

const mocks = vi.hoisted(() => ({
  act: vi.fn(),
  clear: vi.fn(),
  list: vi.fn(),
  replace: vi.fn(),
}));

const results: ResultInboxItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'report',
    automationKey: 'security_auditor',
    automationName: 'Security Auditor',
    title: null,
    content:
      '# Important report\n\n**Review** https://example.com/details and PR #2343 before release. ![Architecture diagram](https://example.com/image.png) Add enough supporting detail for the result to overflow at narrow widths.',
    priority: 'critical',
    createdAt: new Date('2026-09-11T10:00:00Z'),
    repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'suggestion',
    automationKey: 'code_quality_auditor',
    automationName: 'Code Quality Auditor',
    title: 'Simplify the worker',
    content: 'Extract the repeated boundary.',
    priority: 'high',
    createdAt: new Date('2026-09-11T09:00:00Z'),
    repositoryUrl: null,
  },
];
let currentResults = results;

vi.mock('next/navigation', () => ({
  usePathname: () => '/results',
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/hooks/useResultsPage', () => ({
  useResultsPage: () => ({ enabled: true, isLoading: false }),
}));

vi.mock('@/components/tasks/TaskAutomationIcon', () => ({
  TaskAutomationIcon: () => <span data-testid="automation-icon" />,
}));

vi.mock('@/components/tasks/NewTaskForm', () => ({
  NewTaskForm: ({
    initialPrompt,
    onTaskStarted,
  }: {
    initialPrompt: string;
    onTaskStarted: () => void;
  }) => (
    <div>
      <textarea aria-label="Result prompt" defaultValue={initialPrompt} />
      <button onClick={onTaskStarted}>Send successfully</button>
      <button>Fail send</button>
    </div>
  ),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    results: {
      list: {
        queryKey: () => ['results', 'list'],
        queryOptions: () => ({
          queryKey: ['results', 'list'],
          queryFn: mocks.list,
        }),
      },
      unreadCount: { queryKey: () => ['results', 'count'] },
      act: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: mocks.act,
          ...options,
        }),
      },
      clear: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: mocks.clear,
          ...options,
        }),
      },
    },
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ResultsPage />
      </QueryClientProvider>,
    ),
  };
}

import { ResultsPage } from './ResultsPage';

describe('ResultsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentResults = results;
    mocks.list.mockImplementation(async () => currentResults);
    mocks.act.mockImplementation(
      async (variables: { id: string; kind: string }) => {
        currentResults = currentResults.filter(
          (result) =>
            result.id !== variables.id || result.kind !== variables.kind,
        );
        return { success: true };
      },
    );
    mocks.clear.mockImplementation(async () => {
      currentResults = [];
      return { success: true };
    });
  });

  it('shows a retry action instead of an empty inbox when the initial load fails', async () => {
    mocks.list.mockRejectedValue(new Error('List failed'));

    renderPage();

    expect(
      await screen.findByText('Failed to load results.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No unread results')).not.toBeInTheDocument();
  });

  it('refetches the results query when Retry is clicked', async () => {
    mocks.list.mockRejectedValue(new Error('List failed'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it('recovers to the honest empty state after a successful retry', async () => {
    mocks.list
      .mockRejectedValueOnce(new Error('List failed'))
      .mockResolvedValueOnce([]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No unread results')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load results.'),
    ).not.toBeInTheDocument();
  });

  it('keeps loaded results visible when a later refetch fails', async () => {
    const { queryClient } = renderPage();
    await screen.findByText('Security Auditor');
    mocks.list.mockRejectedValueOnce(new Error('Refresh failed'));

    await queryClient.refetchQueries({ queryKey: ['results', 'list'] });

    expect(screen.getByText('Security Auditor')).toBeInTheDocument();
    expect(screen.getByText('Code Quality Auditor')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load results.'),
    ).not.toBeInTheDocument();
  });

  it('uses the requested column order and compact row actions', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Automation Results' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent),
    ).toEqual(['Produced', 'Automation', 'Result', 'Actions']);
    expect(screen.getByLabelText('Critical priority')).toBeInTheDocument();
    expect(screen.getByLabelText('Critical priority')).toHaveClass(
      'lucide-triangle-alert',
      'text-destructive',
    );
    expect(screen.getByLabelText('High priority')).toBeInTheDocument();
    expect(screen.getByLabelText('High priority')).toHaveClass(
      'lucide-circle-alert',
      'text-warning',
    );
    expect(
      screen.getByRole('button', { name: 'Clear all' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Accept Important report/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Clear Important report/ }),
    ).toBeInTheDocument();
  });

  it('autolinks URLs and repository-backed PR mentions without opening the row', async () => {
    renderPage();

    const url = await screen.findByRole('link', {
      name: 'https://example.com/details',
    });
    const pullRequest = screen.getByRole('link', { name: 'PR #2343' });
    expect(pullRequest).toHaveAttribute(
      'href',
      'https://github.com/RooCodeInc/Roomote/pull/2343',
    );

    fireEvent.keyDown(pullRequest, { key: 'Enter' });
    fireEvent.click(url);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders result Markdown as uniform text while preserving links', async () => {
    const { container } = renderPage();

    expect((await screen.findByText('Important report')).tagName).toBe('DIV');
    expect(
      screen.queryByRole('heading', { name: 'Important report' }),
    ).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Architecture diagram')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://example.com/details' }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows More only for measured overflow and expands without opening the row', async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    const clientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent?.includes('supporting detail') ? 80 : 20;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 40;
      },
    });

    try {
      renderPage();

      const more = await screen.findByRole('button', { name: 'More' });
      expect(screen.getAllByRole('button', { name: 'More' })).toHaveLength(1);
      const content = screen.getByTestId(`result-content-${results[0]!.id}`);
      expect(content).toHaveClass('line-clamp-3');

      fireEvent.keyDown(more, { key: 'Enter' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(more);

      expect(content).not.toHaveClass('line-clamp-3');
      expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      if (scrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollHeight',
          scrollHeight,
        );
      }
      if (clientHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          'clientHeight',
          clientHeight,
        );
      }
    }
  });

  it('removes a row immediately when its check action accepts it', async () => {
    renderPage();
    await screen.findByText('Security Auditor');
    fireEvent.click(
      screen.getByRole('button', { name: /Accept Important report/ }),
    );

    await waitFor(() =>
      expect(screen.queryByText('Security Auditor')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(mocks.act).toHaveBeenCalledWith(
        {
          id: results[0]!.id,
          kind: 'report',
          action: 'accept',
        },
        expect.anything(),
      ),
    );
  });

  it('requires confirmation before clearing every row', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Clear all results?');
    expect(mocks.clear).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Clear all',
      }),
    );

    await waitFor(() =>
      expect(screen.getByText('No unread results')).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledOnce());
  });

  it('shows a toast when a suggestion is ignored', async () => {
    const { toast } = await import('sonner');
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Clear Simplify the worker/ }),
    );

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Simplify the worker was ignored',
      ),
    );
  });

  it('closes the dialog without changing disposition', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Simplify the worker'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog)
        .getAllByRole('button', { name: 'Close' })
        .find((button) => button.textContent === 'Close')!,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.act).not.toHaveBeenCalled();
  });

  it('accepts only after the embedded prompt reports a successful send', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Simplify the worker'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Result prompt')).toHaveValue(
      'Simplify the worker\n\nExtract the repeated boundary.',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fail send' }));
    expect(mocks.act).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send successfully' }),
    );
    await waitFor(() =>
      expect(mocks.act).toHaveBeenCalledWith(
        {
          id: results[1]!.id,
          kind: 'suggestion',
          action: 'accept',
        },
        expect.anything(),
      ),
    );
  });
});
