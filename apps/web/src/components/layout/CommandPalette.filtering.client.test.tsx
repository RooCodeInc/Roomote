import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { push, setOpen, searchSessions } = vi.hoisted(() => ({
  push: vi.fn(),
  setOpen: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

// Keep cmdk's actual filtering and keyboard selection in the regression path.
vi.mock('@/components/system', async () => {
  const { Command } = await import('cmdk');
  const Icon = () => <svg aria-hidden="true" />;
  return {
    CommandDialog: ({
      children,
      value,
      onValueChange,
      filter,
    }: React.ComponentProps<typeof Command>) => (
      <Command value={value} onValueChange={onValueChange} filter={filter}>
        {children}
      </Command>
    ),
    CommandInput: Command.Input,
    CommandList: Command.List,
    CommandEmpty: Command.Empty,
    CommandGroup: Command.Group,
    CommandItem: Command.Item,
    ChartColumnIncreasing: Icon,
    GalleryVerticalEnd: Icon,
    House: Icon,
    Settings: Icon,
    HelpCircle: Icon,
    Plus: Icon,
    Zap: Icon,
  };
});

vi.mock('@/components/sandbox/WorkspaceBadge', () => ({
  WorkspaceBadge: () => null,
}));
vi.mock('@/hooks/useRecentTasks', () => ({
  useRecentTasks: () => ({ recentTaskIds: [] }),
}));
vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({ isSignedIn: true, user: {} }),
}));
vi.mock('./CommandPaletteContext', () => ({
  useCommandPalette: () => ({ open: true, setOpen, commands: [] }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      search: {
        queryOptions: (input: unknown) => ({
          queryKey: ['tasks', input],
          queryFn: async () => [],
        }),
      },
    },
    sessions: {
      search: {
        queryOptions: (input: { query: string }) => ({
          queryKey: ['sessions', input],
          queryFn: () => searchSessions(input.query),
        }),
      },
    },
  }),
}));

import { CommandPalette } from './CommandPalette';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  searchSessions.mockImplementation(async (query: string) => ({
    sessions: ['billing', 'launch'].includes(query.trim().toLowerCase())
      ? [
          {
            id: 'session-launch',
            title: 'Summarize launch readiness',
            executionCount: 0,
            searchSnippet:
              'Authentication, billing, and rollback checks passed.',
          },
        ]
      : [],
  }));
});

function renderPalette() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CommandPalette />
    </QueryClientProvider>,
  );
  return screen.getByRole('combobox');
}

it.each(['billing', ' BILLING '])(
  'keeps server transcript match %j visible and keyboard-selectable without a title match',
  async (query) => {
    const input = renderPalette();
    fireEvent.change(input, { target: { value: query } });

    const result = await screen.findByRole('option', {
      name: /Summarize launch readiness/,
    });
    expect(result).toBeVisible();
    expect(input).toHaveValue(query);
    expect(screen.queryByText('No results found.')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/sessions/session-launch');
    expect(setOpen).toHaveBeenCalledWith(false);
  },
);

it('preserves title matches, local navigation filtering, and the empty state after changing queries', async () => {
  const input = renderPalette();
  fireEvent.change(input, { target: { value: 'launch' } });
  expect(
    await screen.findByRole('option', { name: /Summarize launch readiness/ }),
  ).toBeVisible();

  fireEvent.change(input, { target: { value: ' settings ' } });
  expect(screen.getByRole('option', { name: 'Settings' })).toBeVisible();
  await waitFor(() =>
    expect(searchSessions).toHaveBeenCalledWith(' settings '),
  );
  expect(
    screen.queryByRole('option', { name: /Summarize launch readiness/ }),
  ).toBeNull();

  fireEvent.change(input, { target: { value: 'no-matching-conversation' } });
  await waitFor(() =>
    expect(searchSessions).toHaveBeenCalledWith('no-matching-conversation'),
  );
  expect(await screen.findByText('No results found.')).toBeVisible();
  expect(screen.queryByRole('option')).toBeNull();
});
