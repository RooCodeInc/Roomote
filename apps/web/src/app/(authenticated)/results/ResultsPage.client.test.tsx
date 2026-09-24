import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import type { ResultInboxItem } from '@/trpc/commands/results';

const mocks = vi.hoisted(() => ({
  acceptSuggestion: vi.fn(),
  clear: vi.fn(),
  clearOne: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  replace: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  searchParams: new URLSearchParams(),
  isDesktop: true,
}));

const results: ResultInboxItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'report',
    automationKey: 'security_auditor',
    automationName: 'Security Auditor',
    headline: 'Three dependency risks need review',
    decisionContext: 'The report is limited to the API workspace.',
    content: '# Full report\n\nThree dependency risks were found.',
    priority: 'critical',
    preparationStatus: 'ready',
    createdAt: new Date('2026-09-11T10:00:00Z'),
    pullRequests: [
      {
        url: 'https://github.com/RooCodeInc/Roomote/pull/1',
        title: 'Add result links',
        repository: 'RooCodeInc/Roomote',
        number: 1,
      },
      {
        url: 'https://gitlab.com/RooCodeInc/Docs/-/merge_requests/12',
        title: 'Update docs',
        repository: 'RooCodeInc/Docs',
        number: 12,
      },
    ],
    actions: [
      {
        kind: 'navigate',
        action: 'open_task',
        label: 'Open task',
        href: '/task/task-1',
        external: false,
      },
      {
        kind: 'navigate',
        action: 'open_pr',
        label: 'Open pull request',
        href: 'https://github.com/RooCodeInc/Roomote/pull/1',
        external: true,
      },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'suggestion',
    automationKey: 'code_quality_auditor',
    automationName: 'Code Quality Auditor',
    headline: 'Simplify the worker',
    decisionContext: 'Extract the repeated boundary.',
    content: '',
    priority: 'high',
    preparationStatus: 'not_required',
    createdAt: new Date('2026-09-11T09:00:00Z'),
    pullRequests: [],
    actions: [
      {
        kind: 'start_suggestion',
        action: 'start_investigation',
        label: 'Start investigation',
        initialPrompt: 'Simplify the worker\n\nExtract the repeated boundary.',
      },
    ],
  },
];
let currentResults = results;

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: () => mocks.isDesktop,
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('@/hooks/useTelemetry', () => ({
  useTelemetry: () => ({ capture: vi.fn() }),
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
      <textarea aria-label="Suggestion prompt" defaultValue={initialPrompt} />
      <button onClick={onTaskStarted}>Start successfully</button>
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
      get: {
        queryOptions: (input: { id: string; kind: string }) => ({
          queryKey: ['results', 'get', input],
          queryFn: () => mocks.get(input),
        }),
      },
      pendingCount: { queryKey: () => ['results', 'pending-count'] },
      unreadCount: { queryKey: () => ['results', 'unread-count'] },
      clearOne: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: mocks.clearOne,
          ...options,
        }),
      },
      clear: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: mocks.clear,
          ...options,
        }),
      },
      acceptSuggestion: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: mocks.acceptSuggestion,
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
  return render(
    <QueryClientProvider client={queryClient}>
      <ResultsPage />
    </QueryClientProvider>,
  );
}

import { ResultsPage } from './ResultsPage';

describe('ResultsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktop = true;
    mocks.searchParams = new URLSearchParams();
    currentResults = results;
    mocks.list.mockImplementation(async () => currentResults);
    mocks.get.mockImplementation(
      async (input: { id: string; kind: string }) =>
        currentResults.find(
          (result) => result.id === input.id && result.kind === input.kind,
        ) ?? null,
    );
    mocks.clearOne.mockImplementation(
      async (variables: { id: string; kind: string }) => {
        currentResults = currentResults.filter(
          (result) =>
            result.id !== variables.id || result.kind !== variables.kind,
        );
        return { success: true };
      },
    );
    mocks.clear.mockResolvedValue({ success: true, clearedCount: 2 });
    mocks.acceptSuggestion.mockResolvedValue({ success: true });
  });

  it('shows a retry action when the initial load fails', async () => {
    mocks.list.mockRejectedValue(new Error('List failed'));
    renderPage();
    expect(
      await screen.findByText('Failed to load results.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('starts collapsed and opens the selected report on desktop', async () => {
    renderPage();
    const first = await screen.findByRole('button', {
      name: /Three dependency risks need review/,
    });
    expect(first).not.toHaveAttribute('aria-current');
    expect(
      screen.queryByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(first);
    expect(
      await screen.findByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('The report is limited to the API workspace.'),
    ).toHaveLength(2);
    expect(
      screen.getByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Full report')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open task' })).toHaveAttribute(
      'href',
      '/task/task-1',
    );
    expect(
      screen.getByRole('link', { name: 'Open task' }).querySelector('svg'),
    ).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'Open pull request' })
        .querySelector('svg'),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Start investigation' }),
    ).not.toBeInTheDocument();
  });

  it('shows all associated PRs with the shared badge format in the result footer', async () => {
    renderPage();
    const first = await screen.findByRole('button', {
      name: /Three dependency risks need review/,
    });
    const githubPr = screen.getByRole('link', {
      name: 'Roomote#1',
    });
    const gitlabPr = screen.getByRole('link', {
      name: 'Docs#12',
    });

    expect(githubPr).toHaveAttribute(
      'href',
      'https://github.com/RooCodeInc/Roomote/pull/1',
    );
    expect(githubPr).toHaveAttribute('target', '_blank');
    expect(githubPr).toHaveAttribute('rel', 'noopener noreferrer');
    expect(githubPr.querySelector('svg')).toBeInTheDocument();
    expect(gitlabPr).toHaveAttribute(
      'href',
      'https://gitlab.com/RooCodeInc/Docs/-/merge_requests/12',
    );
    expect(first).not.toContainElement(githubPr);

    const suggestionRow = screen.getAllByRole('listitem')[1]!;
    expect(within(suggestionRow).queryByRole('link')).not.toBeInTheDocument();
  });

  it('opens an explicitly selected result from the URL', async () => {
    mocks.searchParams = new URLSearchParams({
      result: `report:${results[0]!.id}`,
    });
    renderPage();

    expect(
      await screen.findByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Three dependency risks need review/,
      }),
    ).toHaveAttribute('aria-current', 'true');
  });

  it('closes the selected detail panel without selecting another result', async () => {
    renderPage();
    const first = await screen.findByRole('button', {
      name: /Three dependency risks need review/,
    });
    fireEvent.click(first);
    await screen.findByRole('heading', {
      name: 'Three dependency risks need review',
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Close result details' }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', {
          name: 'Three dependency risks need review',
        }),
      ).not.toBeInTheDocument(),
    );
    expect(first).not.toHaveAttribute('aria-current');
  });

  it('opens mobile detail explicitly and returns to the mounted list', async () => {
    mocks.isDesktop = false;
    renderPage();
    const row = await screen.findByRole('button', {
      name: /Three dependency risks need review/,
    });
    expect(
      screen.queryByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(
      await screen.findByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close result details' }),
    );
    expect(row).toBeInTheDocument();
  });

  it('clears the selected result without treating selection as disposition', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await screen.findByText('Full report');
    expect(mocks.clearOne).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(mocks.clearOne).toHaveBeenCalledWith(
        { id: results[0]!.id, kind: 'report' },
        expect.anything(),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Result cleared');
  });

  it('does not duplicate suggestion context when the result has no body', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Simplify the worker/ }),
    );

    await screen.findByRole('heading', { name: 'Simplify the worker' });
    expect(screen.getAllByText('Extract the repeated boundary.')).toHaveLength(
      2,
    );
  });

  it('starts work only from a persisted suggestion and accepts after launch', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Simplify the worker/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start investigation' }),
    );
    const prompt = screen.getByLabelText('Suggestion prompt');
    expect(prompt).toHaveValue(
      'Simplify the worker\n\nExtract the repeated boundary.',
    );
    fireEvent.click(
      within(prompt.parentElement!).getByRole('button', {
        name: 'Start successfully',
      }),
    );
    await waitFor(() =>
      expect(mocks.acceptSuggestion).toHaveBeenCalledWith(
        { id: results[1]!.id },
        expect.anything(),
      ),
    );
  });

  it('explains where new results will appear when the queue is empty', async () => {
    mocks.list.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(
      screen.getByText(
        'New automation reports and suggested follow-ups will appear here when they are ready.',
      ),
    ).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('retains prior detail for 500ms, hides stale actions, then swaps when ready', async () => {
    let resolveSuggestion!: (result: ResultInboxItem) => void;
    const delayedSuggestion = new Promise<ResultInboxItem>((resolve) => {
      resolveSuggestion = resolve;
    });
    mocks.get.mockImplementation((input: { id: string }) =>
      input.id === results[1]!.id
        ? delayedSuggestion
        : Promise.resolve(results[0]),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await screen.findByText('Full report');

    fireEvent.click(
      screen.getByRole('button', { name: /Simplify the worker/ }),
    );
    expect(screen.getByText('Full report')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open task' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Start investigation' }),
    ).toBeNull();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 510));
    });
    expect(screen.queryByText('Full report')).toBeNull();

    await act(async () => {
      resolveSuggestion(results[1]!);
      await delayedSuggestion;
    });
    expect(
      await screen.findByRole('heading', { name: 'Simplify the worker' }),
    ).toBeInTheDocument();
  });

  it('ignores a stale detail response after selection returns to another row', async () => {
    let resolveSuggestion!: (result: ResultInboxItem) => void;
    const delayedSuggestion = new Promise<ResultInboxItem>((resolve) => {
      resolveSuggestion = resolve;
    });
    mocks.get.mockImplementation((input: { id: string }) =>
      input.id === results[1]!.id
        ? delayedSuggestion
        : Promise.resolve(results[0]),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await screen.findByText('Full report');
    fireEvent.click(
      screen.getByRole('button', { name: /Simplify the worker/ }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await act(async () => {
      resolveSuggestion(results[1]!);
      await delayedSuggestion;
    });
    expect(
      screen.getByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Simplify the worker' }),
    ).toBeNull();
  });

  it('falls back to the loaded list item when the detail fetch rejects', async () => {
    mocks.get.mockImplementation((input: { id: string }) =>
      input.id === results[1]!.id
        ? Promise.reject(new Error('Detail failed'))
        : Promise.resolve(results[0]),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await screen.findByText('Full report');
    fireEvent.click(
      screen.getByRole('button', { name: /Simplify the worker/ }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Simplify the worker' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('Extract the repeated boundary.').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: 'Start investigation' }),
    ).toBeInTheDocument();
  });

  it('navigates rows with arrows and activates the current main action with Enter', async () => {
    renderPage();
    const first = await screen.findByRole('button', {
      name: /Three dependency risks need review/,
    });
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    await screen.findByText('Full report');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    const second = screen.getByRole('button', { name: /Simplify the worker/ });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute('aria-current', 'true');
    await screen.findByRole('button', { name: 'Start investigation' });

    fireEvent.keyDown(document.body, { key: 'Enter' });
    const prompt = await screen.findByLabelText('Suggestion prompt');
    prompt.focus();
    fireEvent.keyDown(prompt, { key: 'Delete' });
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(mocks.clearOne).not.toHaveBeenCalled();
    expect(mocks.acceptSuggestion).not.toHaveBeenCalled();
  });

  it('clears the current result with Delete without double activation', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Three dependency risks need review/,
      }),
    );
    await screen.findByText('Full report');
    fireEvent.keyDown(document.body, { key: 'Delete', repeat: false });
    fireEvent.keyDown(document.body, { key: 'Delete', repeat: true });
    await waitFor(() => expect(mocks.clearOne).toHaveBeenCalledTimes(1));
    expect(mocks.clearOne).toHaveBeenCalledWith(
      { id: results[0]!.id, kind: 'report' },
      expect.anything(),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Result cleared');
  });
});
