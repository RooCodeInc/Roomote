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
  replace: vi.fn(),
}));

const results: ResultInboxItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'report',
    automationKey: 'security_auditor',
    automationName: 'Security Auditor',
    title: null,
    content: '# Important report\n\nAdd more detail here.',
    priority: 'critical',
    createdAt: new Date('2026-09-11T10:00:00Z'),
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
  },
];
let currentResults = results;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
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
          queryFn: async () => currentResults,
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
    currentResults = results;
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

  it('uses the requested column order and compact row actions', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Automation Results' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent),
    ).toEqual(['Priority', 'Date', 'Automation', 'Result', 'Actions']);
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

  it('clears every row immediately from Clear all', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));

    await waitFor(() =>
      expect(screen.getByText('No unread results')).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledOnce());
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
