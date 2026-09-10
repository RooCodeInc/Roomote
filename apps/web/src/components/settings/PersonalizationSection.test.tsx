import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  settings: {
    instructions: 'Be concise.',
    learnFromConversations: true,
    version: 3,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({
    data: mocks.settings,
    isPending: false,
  })),
  useMutation: vi.fn(() => ({ mutate: mocks.mutate, isPending: false })),
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
        mutationOptions: (options: unknown) => options,
      },
    },
  }),
}));

import { PersonalizationSection } from './PersonalizationSection';

describe('PersonalizationSection', () => {
  beforeEach(() => mocks.mutate.mockClear());

  it('saves an edited blob with its concurrency version', () => {
    render(<PersonalizationSection />);

    fireEvent.change(screen.getByLabelText('Personal instructions'), {
      target: { value: 'Lead with a recommendation.' },
    });
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
});
