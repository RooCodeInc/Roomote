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
  acceptSuggestion: vi.fn(),
  clear: vi.fn(),
  clearOne: vi.fn(),
  list: vi.fn(),
  replace: vi.fn(),
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
    actions: [
      {
        kind: 'navigate',
        action: 'open_task',
        label: 'Open task',
        href: '/task/task-1',
        external: false,
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
    content: 'Extract the repeated boundary.',
    priority: 'high',
    preparationStatus: 'not_required',
    createdAt: new Date('2026-09-11T09:00:00Z'),
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
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock('usehooks-ts', () => ({
  useMediaQuery: () => mocks.isDesktop,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/hooks/useResultsPage', () => ({
  useResultsPage: () => ({ enabled: true, isLoading: false }),
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
    currentResults = results;
    mocks.list.mockImplementation(async () => currentResults);
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

  it('renders concise rows and the complete selected report on desktop', async () => {
    renderPage();
    expect(
      await screen.findByRole('option', {
        name: /Three dependency risks need review/,
      }),
    ).toHaveAttribute('aria-selected', 'true');
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
      screen.queryByRole('button', { name: 'Start investigation' }),
    ).not.toBeInTheDocument();
  });

  it('opens mobile detail explicitly and returns to the mounted list', async () => {
    mocks.isDesktop = false;
    renderPage();
    const row = await screen.findByRole('option', {
      name: /Three dependency risks need review/,
    });
    expect(
      screen.queryByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(
      screen.getByRole('heading', {
        name: 'Three dependency risks need review',
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
    expect(row).toBeInTheDocument();
  });

  it('clears the selected result without treating selection as disposition', async () => {
    renderPage();
    await screen.findByText('Full report');
    expect(mocks.clearOne).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(mocks.clearOne).toHaveBeenCalledWith(
        { id: results[0]!.id, kind: 'report' },
        expect.anything(),
      ),
    );
  });

  it('starts work only from a persisted suggestion and accepts after launch', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('option', { name: /Simplify the worker/ }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Start investigation' }),
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

  it('uses pending language for an empty queue', async () => {
    mocks.list.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No pending results')).toBeInTheDocument();
  });
});
