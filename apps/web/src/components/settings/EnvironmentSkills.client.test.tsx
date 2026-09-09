import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

const { state, saveMock, removeMock } = vi.hoisted(() => ({
  state: {
    environments: [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Beta' },
    ],
    installed: [
      {
        kind: 'manual' as const,
        source: 'manual',
        name: 'release-checklist',
        skillId: 'manual@release-checklist#1234567890ab',
        isAllSelection: false,
        installsLabel: null,
        url: null,
        description: 'Use when preparing a release.',
        content: '# Release checklist',
        environments: [
          { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha' },
        ],
      },
      {
        kind: 'marketplace' as const,
        source: 'vercel-labs/agent-skills',
        name: 'vercel-react-best-practices',
        skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
        isAllSelection: false,
        installsLabel: null,
        url: null,
        description: 'Marketplace skill',
        content: null,
        environments: [
          { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha' },
        ],
      },
    ],
  },
  saveMock: vi.fn(async (_input: unknown) => ({ success: true })),
  removeMock: vi.fn(async (_input: unknown) => ({ success: true })),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    customSkills: {
      list: {
        queryKey: () => ['customSkills', 'list'],
        queryOptions: () => ({
          queryKey: ['customSkills', 'list'],
          queryFn: async () => ({
            deploymentName: 'this deployment',
            environments: state.environments,
            installed: state.installed,
          }),
        }),
      },
      saveManual: {
        mutationOptions: (options = {}) => ({
          mutationFn: saveMock,
          ...options,
        }),
      },
      remove: {
        mutationOptions: (options = {}) => ({
          mutationFn: removeMock,
          ...options,
        }),
      },
    },
  }),
}));

import { EnvironmentSkills } from './EnvironmentSkills';

function renderEnvironmentSkills() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentSkills />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.environments = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Alpha' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Beta' },
  ];
});

it('is collapsed by default and excludes marketplace skills and controls', async () => {
  renderEnvironmentSkills();

  const summary = await screen.findByText('Environment skills');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('release-checklist')).not.toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Add environment skill' }),
  ).not.toBeVisible();
  expect(
    screen.queryByText('vercel-react-best-practices'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/marketplace/i)).not.toBeInTheDocument();

  fireEvent.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('release-checklist')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Add environment skill' }),
  ).toBeVisible();
});

it('hides environment management when there are no environments', async () => {
  state.environments = [];
  const { container } = renderEnvironmentSkills();

  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

it('views and edits an existing environment skill', async () => {
  renderEnvironmentSkills();
  fireEvent.click(await screen.findByText('Environment skills'));

  fireEvent.click(
    screen.getByRole('button', { name: 'View release-checklist' }),
  );
  const viewDialog = screen.getByRole('dialog');
  expect(
    within(viewDialog).getByText('# Release checklist'),
  ).toBeInTheDocument();
  expect(within(viewDialog).getByText('Enabled in Alpha')).toBeInTheDocument();
  fireEvent.click(
    within(viewDialog).getAllByRole('button', { name: 'Close' })[0]!,
  );

  fireEvent.click(
    screen.getByRole('button', { name: 'Edit release-checklist' }),
  );
  const editDialog = screen.getByRole('dialog');
  expect(within(editDialog).getByLabelText('Slug')).toHaveValue(
    'release-checklist',
  );
  expect(within(editDialog).getByLabelText('Alpha')).toBeChecked();
  expect(within(editDialog).getByLabelText('Beta')).not.toBeChecked();
  fireEvent.change(within(editDialog).getByLabelText('Content'), {
    target: { value: '# Updated checklist' },
  });
  fireEvent.click(within(editDialog).getByLabelText('Beta'));
  fireEvent.click(
    within(editDialog).getByRole('button', { name: 'Save Skill' }),
  );

  await waitFor(() => expect(saveMock).toHaveBeenCalled());
  expect(saveMock.mock.calls[0]?.[0]).toEqual({
    name: 'release-checklist',
    description: 'Use when preparing a release.',
    content: '# Updated checklist',
    environmentIds: [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ],
    previousSkillId: 'manual@release-checklist#1234567890ab',
  });
});

it('creates and deletes environment skills through the existing mutations', async () => {
  renderEnvironmentSkills();
  fireEvent.click(await screen.findByText('Environment skills'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Add environment skill' }),
  );

  const createDialog = screen.getByRole('dialog');
  fireEvent.change(within(createDialog).getByLabelText('Slug'), {
    target: { value: 'my new/skill' },
  });
  fireEvent.change(within(createDialog).getByLabelText('Description'), {
    target: { value: 'Use for a new workflow.' },
  });
  fireEvent.change(within(createDialog).getByLabelText('Content'), {
    target: { value: '# New instructions' },
  });
  fireEvent.click(within(createDialog).getByLabelText('Beta'));
  fireEvent.click(
    within(createDialog).getByRole('button', { name: 'Save Skill' }),
  );

  await waitFor(() => expect(saveMock).toHaveBeenCalled());
  expect(saveMock.mock.calls[0]?.[0]).toEqual({
    name: 'mynewskill',
    description: 'Use for a new workflow.',
    content: '# New instructions',
    environmentIds: ['00000000-0000-4000-8000-000000000002'],
    previousSkillId: undefined,
  });

  fireEvent.click(
    screen.getByRole('button', { name: 'Delete release-checklist' }),
  );
  const deleteDialog = screen.getByRole('dialog');
  expect(removeMock).not.toHaveBeenCalled();
  fireEvent.click(
    within(deleteDialog).getByRole('button', { name: 'Delete Skill' }),
  );
  await waitFor(() => expect(removeMock).toHaveBeenCalled());
  expect(removeMock.mock.calls[0]?.[0]).toEqual({
    skillId: 'manual@release-checklist#1234567890ab',
  });
});
