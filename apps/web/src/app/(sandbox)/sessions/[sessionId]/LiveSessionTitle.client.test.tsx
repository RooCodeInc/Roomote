import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  queryState: {
    data: undefined as { title: string } | undefined,
  },
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: mocks.queryState.data }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: {
      byId: {
        queryOptions: (input: unknown) => ({
          queryKey: ['sessions.byId', input],
        }),
      },
      list: { queryKey: () => ['sessions.list'] },
    },
  }),
}));

vi.mock('./EditableSessionTitle', () => ({
  EditableSessionTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { LiveSessionTitle } from './LiveSessionTitle';

describe('LiveSessionTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryState.data = undefined;
  });

  it('renders the polled canonical title and invalidates session lists', async () => {
    const { rerender } = render(
      <LiveSessionTitle
        sessionId="session-1"
        initialTitle="New session"
        canRename
        className="title"
      />,
    );
    expect(screen.getByRole('heading', { name: 'New session' })).toBeVisible();

    mocks.queryState.data = { title: 'Investigate title retries' };
    rerender(
      <LiveSessionTitle
        sessionId="session-1"
        initialTitle="New session"
        canRename
        className="title"
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Investigate title retries' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['sessions.list'],
      }),
    );
  });
});
