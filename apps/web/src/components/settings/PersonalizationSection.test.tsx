import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
  refetch: vi.fn(),
  setQueryData: vi.fn(),
  updateOptions: undefined as
    | { onError: (error: { message: string }) => void }
    | undefined,
  query: {
    data: undefined as unknown,
    isError: false,
    isFetching: false,
    isPending: false,
  },
  settings: {
    instructions: 'Be concise.',
    learnFromConversations: true,
    version: 3,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({ ...mocks.query, refetch: mocks.refetch })),
  useMutation: vi.fn((options: typeof mocks.updateOptions) => {
    mocks.updateOptions = options;
    return { mutate: mocks.mutate, isPending: false };
  }),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  })),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    preferences: {
      getPersonalization: {
        queryKey: () => ['personalization'],
        queryOptions: () => ({}),
      },
      updatePersonalization: {
        mutationOptions: (options: typeof mocks.updateOptions) => options,
      },
    },
  }),
}));

import { PersonalizationSection } from './PersonalizationSection';

describe('PersonalizationSection', () => {
  beforeEach(() => {
    mocks.mutate.mockClear();
    mocks.refetch.mockClear();
    mocks.invalidateQueries.mockClear();
    mocks.updateOptions = undefined;
    mocks.query.data = mocks.settings;
    mocks.query.isError = false;
    mocks.query.isFetching = false;
    mocks.query.isPending = false;
  });

  it('shows a retryable error when the initial load fails', () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;

    render(<PersonalizationSection />);

    expect(
      screen.getByText('Failed to load personalization settings.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(
      screen.queryByLabelText('Learn from conversations'),
    ).not.toBeInTheDocument();
  });

  it('refetches after an initial load error', () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;

    render(<PersonalizationSection />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it('disables Retry while the initial load is pending', () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;
    mocks.query.isFetching = true;

    render(<PersonalizationSection />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('keeps the initial pending state free of an error message', () => {
    mocks.query.data = undefined;
    mocks.query.isPending = true;

    render(<PersonalizationSection />);

    expect(
      screen.queryByText('Failed to load personalization settings.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        'Things Roomote should always know about you to be more useful. Not shared with others.',
      ),
    ).toBeDisabled();
  });

  it('renders a successful empty personalization editor', () => {
    mocks.query.data = { ...mocks.settings, instructions: '' };

    render(<PersonalizationSection />);

    expect(
      screen.getByLabelText(
        'Things Roomote should always know about you to be more useful. Not shared with others.',
      ),
    ).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
  });

  it('keeps cached personalization usable after a background error', () => {
    mocks.query.isError = true;
    mocks.query.isFetching = false;

    render(<PersonalizationSection />);

    expect(
      screen.queryByText('Failed to load personalization settings.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Learn from conversations' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
  });

  it('saves an edited blob with its concurrency version', () => {
    render(<PersonalizationSection />);

    fireEvent.change(
      screen.getByLabelText(
        'Things Roomote should always know about you to be more useful. Not shared with others.',
      ),
      {
        target: { value: 'Lead with a recommendation.' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        expectedVersion: 3,
        instructions: 'Lead with a recommendation.',
      },
      expect.any(Object),
    );
  });

  it('resets every saved preference through the versioned mutation', () => {
    render(<PersonalizationSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      { expectedVersion: 3, reset: true },
      expect.any(Object),
    );
  });

  it('updates learning separately and leaves the blob untouched', () => {
    render(<PersonalizationSection />);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Learn from conversations' }),
    );

    expect(mocks.mutate).toHaveBeenCalledWith({
      expectedVersion: 3,
      learnFromConversations: false,
    });
  });

  it('keeps mutation failures on the existing invalidation path', () => {
    render(<PersonalizationSection />);

    mocks.updateOptions?.onError({ message: 'Save failed' });

    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['personalization'],
    });
  });
});
