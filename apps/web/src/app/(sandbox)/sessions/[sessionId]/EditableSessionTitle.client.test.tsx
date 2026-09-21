import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { renameMutationMock, useTRPCMock } = vi.hoisted(() => ({
  renameMutationMock: vi.fn(async () => undefined),
  useTRPCMock: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: useTRPCMock,
}));

import { EditableSessionTitle } from './EditableSessionTitle';

function renderTitle(
  props: Partial<Parameters<typeof EditableSessionTitle>[0]> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const onTitleChange = vi.fn();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <EditableSessionTitle
        sessionId="session-1"
        title="Session title"
        canRename
        className="title-layout"
        onTitleChange={onTitleChange}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { ...result, onTitleChange, queryClient };
}

describe('EditableSessionTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTRPCMock.mockReturnValue({
      sessions: {
        rename: {
          mutationOptions: () => ({ mutationFn: renameMutationMock }),
        },
        byId: {
          queryKey: (input: unknown) => ['sessions.byId', input],
        },
        list: { queryKey: () => ['sessions.list'] },
        search: { queryKey: () => ['sessions.search'] },
      },
    });
  });

  it('keeps the unfocused title layout class and opens from mouse or keyboard', () => {
    renderTitle();
    const heading = screen.getByRole('button', { name: 'Edit session title' });

    expect(heading).toHaveClass('title-layout');
    fireEvent.click(heading);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.keyDown(heading, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('saves a trimmed title and refreshes session queries', async () => {
    const { onTitleChange, queryClient } = renderTitle();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByRole('button', { name: 'Edit session title' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  Renamed session  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(renameMutationMock).toHaveBeenCalledWith(
        { sessionId: 'session-1', title: 'Renamed session' },
        expect.any(Object),
      );
      expect(onTitleChange).toHaveBeenCalledWith('Renamed session');
      expect(screen.getByText('Renamed session')).toBeInTheDocument();
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['sessions.list'],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['sessions.search'],
      });
    });
  });

  it('cancels without saving and disables empty saves', () => {
    renderTitle();

    fireEvent.click(screen.getByRole('button', { name: 'Edit session title' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Changed title' },
    });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(renameMutationMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(renameMutationMock).not.toHaveBeenCalled();
    expect(screen.getByText('Session title')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit session title' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders a non-interactive heading when renaming is not allowed', () => {
    renderTitle({ canRename: false });

    expect(
      screen.getByRole('heading', { name: 'Session title' }),
    ).not.toHaveAttribute('tabindex');
    expect(
      screen.queryByRole('button', { name: 'Edit session title' }),
    ).not.toBeInTheDocument();
  });
});
