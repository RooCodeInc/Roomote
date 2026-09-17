import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    platformIssueReports: {
      submit: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: submitMock,
          ...options,
        }),
      },
    },
  }),
}));

import { PlatformIssueSubmission } from './PlatformIssueSubmission';

const REPORT = {
  id: '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0',
  title: 'Worker cannot start',
  summary: 'The configured worker exits before claiming the task.',
  sourceLabel: 'task' as const,
  taskUrl: 'https://app.example.com/task/task-1',
  submittedAt: null,
};

function renderSubmission() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformIssueSubmission report={REPORT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  submitMock.mockResolvedValue({ success: true, submittedAt: new Date() });
});

it('labels a Session-origin report with its Session context', () => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PlatformIssueSubmission
        report={{
          ...REPORT,
          sourceLabel: 'Session',
          taskUrl: 'https://app.example.com/sessions/session-1',
        }}
      />
    </QueryClientProvider>,
  );

  expect(screen.getByText('Session link')).toBeInTheDocument();
});

it('shows exactly what will be shared without submitting on page load', () => {
  renderSubmission();

  expect(screen.getByText(REPORT.title)).toBeInTheDocument();
  expect(screen.getByText(REPORT.summary)).toBeInTheDocument();
  expect(screen.getByText(REPORT.taskUrl)).toBeInTheDocument();
  expect(
    screen.getByText('Nothing has been sent yet.', { exact: false }),
  ).toBeInTheDocument();
  expect(submitMock).not.toHaveBeenCalled();
});

it('submits only after explicit confirmation and shows success', async () => {
  renderSubmission();

  fireEvent.click(screen.getByRole('button', { name: 'Send to Roomote' }));

  await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
  expect(submitMock.mock.calls[0]?.[0]).toEqual({ reportId: REPORT.id });
  expect(await screen.findByText('Report sent to Roomote')).toBeInTheDocument();
});

it('keeps the confirmation retryable after a delivery failure', async () => {
  submitMock.mockResolvedValue({
    success: false,
    error: 'Roomote could not receive this report. Please try again.',
  });
  renderSubmission();

  fireEvent.click(screen.getByRole('button', { name: 'Send to Roomote' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Roomote could not receive this report. Please try again.',
  );
  expect(screen.getByRole('button', { name: 'Send to Roomote' })).toBeEnabled();
});
