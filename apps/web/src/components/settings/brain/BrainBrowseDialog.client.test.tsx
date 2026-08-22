import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { BrainCorpusSummary } from '@/trpc/commands/brain';

const { listInputs } = vi.hoisted(() => ({
  listInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previousData: unknown) => previousData,
  useQuery: (options: { queryKind?: string }) =>
    options.queryKind === 'page'
      ? { isPending: true, data: undefined }
      : {
          isPending: false,
          data: {
            reachable: true,
            total: 250,
            nextOffset: 100,
            pages: [
              {
                slug: 'tasks/run-2',
                title: 'Second run',
                namespaceId: 'tasks',
                namespaceLabel: 'Task memories',
                updatedAt: new Date('2026-01-02T00:00:00Z'),
              },
              {
                slug: 'tasks/run-1',
                title: 'First run',
                namespaceId: 'tasks',
                namespaceLabel: 'Task memories',
                updatedAt: new Date('2026-01-01T00:00:00Z'),
              },
            ],
          },
        },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    brain: {
      listPages: {
        queryOptions: (input: Record<string, unknown>) => {
          listInputs.push(input);
          return { queryKind: 'list' };
        },
      },
      getPage: {
        queryOptions: () => ({ queryKind: 'page' }),
      },
    },
  }),
}));

const { BrainBrowseDialog } = await import('./BrainBrowseDialog');

const corpus: BrainCorpusSummary = {
  reachable: true,
  listedPages: 250,
  totalPages: 250,
  namespaces: [{ id: 'tasks', label: 'Task memories', pages: 250 }],
  activityByDay: [],
  recentPages: [],
};

beforeEach(() => {
  listInputs.length = 0;
});

it('debounces server-side search and pages bounded results', async () => {
  render(
    <BrainBrowseDialog open onOpenChange={() => undefined} corpus={corpus} />,
  );

  expect(screen.getByText('1-2 of 250')).toBeInTheDocument();
  expect(listInputs.at(-1)).toMatchObject({ offset: 0, limit: 100 });

  fireEvent.change(screen.getByLabelText('Search pages'), {
    target: { value: 'drainer' },
  });

  await waitFor(() =>
    expect(listInputs.at(-1)).toMatchObject({ search: 'drainer', offset: 0 }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(listInputs.at(-1)).toMatchObject({ search: 'drainer', offset: 100 });
});
