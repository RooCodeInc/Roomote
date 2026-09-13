import { useState } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import type { BrainCorpusSummary } from '@/trpc/commands/brain';

const { listInputs, state } = vi.hoisted(() => ({
  listInputs: [] as Array<Record<string, unknown>>,
  state: {
    pagePending: false,
    pageData: undefined as
      | undefined
      | {
          slug: string;
          title: string;
          updatedAt: Date;
          content: string;
          contentTruncated: boolean;
        },
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/memory',
  useSearchParams: () => new URLSearchParams('section=browse'),
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (previousData: unknown) => previousData,
  useQuery: (options: { queryKind?: string; input?: { offset?: number } }) =>
    options.queryKind === 'page'
      ? { isPending: state.pagePending, data: state.pageData }
      : {
          isPending: false,
          data: {
            reachable: true,
            total: 250,
            nextOffset: options.input?.offset === 100 ? null : 100,
            pages:
              options.input?.offset === 100
                ? [
                    {
                      slug: 'tasks/run-4',
                      title: 'Fourth run',
                      namespaceId: 'tasks',
                      namespaceLabel: 'Task memories',
                      updatedAt: new Date('2026-01-04T00:00:00Z'),
                    },
                    {
                      slug: 'tasks/run-3',
                      title: 'Third run',
                      namespaceId: 'tasks',
                      namespaceLabel: 'Task memories',
                      updatedAt: new Date('2026-01-03T00:00:00Z'),
                    },
                  ]
                : [
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
          return { queryKind: 'list', input };
        },
      },
      getPage: {
        queryOptions: () => ({ queryKind: 'page' }),
      },
    },
  }),
}));

const { BrainBrowseSection } = await import('./BrainBrowseSection');

const corpus: BrainCorpusSummary = {
  reachable: true,
  listedPages: 250,
  totalPages: 250,
  namespaces: [{ id: 'tasks', label: 'Task memories', pages: 250 }],
  activityByDay: [],
};

beforeEach(() => {
  listInputs.length = 0;
  state.pagePending = false;
  state.pageData = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

it('debounces server-side search and pages bounded results', async () => {
  render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug={null}
      onSelectNamespace={() => undefined}
      onSelectMemory={() => undefined}
    />,
  );

  expect(screen.getByText('Explore memories')).toBeInTheDocument();
  expect(screen.getByText('1-2 of 250')).toBeInTheDocument();
  expect(screen.queryByText('Select a page')).not.toBeInTheDocument();
  expect(screen.queryByText('tasks/run-2')).not.toBeInTheDocument();
  expect(listInputs.at(-1)).toMatchObject({ offset: 0, limit: 100 });

  fireEvent.change(screen.getByLabelText('Search memories'), {
    target: { value: 'drainer' },
  });

  await waitFor(() =>
    expect(listInputs.at(-1)).toMatchObject({ search: 'drainer', offset: 0 }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Next memories' }));
  expect(listInputs.at(-1)).toMatchObject({ search: 'drainer', offset: 100 });
});

it('uses the controlled memory selection for embedded browser rows', () => {
  const onSelectMemory = vi.fn();

  render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug={null}
      onSelectNamespace={() => undefined}
      onSelectMemory={onSelectMemory}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /Second run/ }));
  expect(onSelectMemory).toHaveBeenCalledWith('tasks/run-2');
});

function KeyboardNavigationHarness() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    'tasks/run-2',
  );

  return (
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug={selectedSlug}
      onSelectNamespace={() => undefined}
      onSelectMemory={setSelectedSlug}
    />
  );
}

it('navigates selected memories with arrow keys across result pages', async () => {
  render(<KeyboardNavigationHarness />);

  const secondRun = screen.getByRole('button', { name: /Second run/ });
  secondRun.focus();
  fireEvent.keyDown(secondRun, {
    key: 'ArrowDown',
  });

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /First run/ })).toHaveAttribute(
      'aria-current',
      'page',
    ),
  );
  expect(screen.getByRole('button', { name: /First run/ })).toHaveFocus();

  fireEvent.keyDown(screen.getByRole('button', { name: /First run/ }), {
    key: 'ArrowDown',
  });

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Fourth run/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(listInputs.at(-1)).toMatchObject({ offset: 100 });
  });

  fireEvent.keyDown(screen.getByRole('button', { name: /Fourth run/ }), {
    key: 'ArrowUp',
  });

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /First run/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(listInputs.at(-1)).toMatchObject({ offset: 0 });
  });
});

it('uses the controlled namespace filter for browser chips', () => {
  const onSelectNamespace = vi.fn();

  render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug={null}
      onSelectNamespace={onSelectNamespace}
      onSelectMemory={() => undefined}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Task memories' }));
  expect(onSelectNamespace).toHaveBeenCalledWith('tasks');
});

it('marks the selected memory and renders its preview beside the list', () => {
  render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug="tasks/run-2"
      onSelectNamespace={() => undefined}
      onSelectMemory={() => undefined}
    />,
  );

  expect(screen.getByRole('button', { name: /Second run/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(screen.getByText('Memory unavailable')).toBeInTheDocument();
});

it('navigates canonical Memory links without allowing unsafe relative URLs', () => {
  const onSelectMemory = vi.fn();
  state.pageData = {
    slug: 'tasks/run-2',
    title: 'Second run',
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    content:
      'Initiated by [A member](people/roomote-member-abc123). [Unsafe](javascript:alert(1)). [File](../../secret).',
    contentTruncated: false,
  };

  render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug="tasks/run-2"
      onSelectNamespace={() => undefined}
      onSelectMemory={onSelectMemory}
    />,
  );

  const memberLink = screen.getByRole('link', { name: 'A member' });
  expect(memberLink).toHaveAttribute(
    'href',
    '/settings/memory?section=browse&memory=people%2Froomote-member-abc123',
  );
  fireEvent.click(memberLink);
  expect(onSelectMemory).toHaveBeenCalledWith('people/roomote-member-abc123');
  expect(
    screen.queryByRole('link', { name: 'Unsafe' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'File' })).not.toBeInTheDocument();
});

it('waits 300 ms before showing a preview skeleton', () => {
  vi.useFakeTimers();
  state.pagePending = true;

  const { container } = render(
    <BrainBrowseSection
      corpus={corpus}
      namespaceId={null}
      selectedSlug="tasks/run-2"
      onSelectNamespace={() => undefined}
      onSelectMemory={() => undefined}
    />,
  );

  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();

  act(() => {
    vi.advanceTimersByTime(300);
  });

  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
});
