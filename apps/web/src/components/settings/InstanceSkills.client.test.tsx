import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

const { state, createMock, updateMock, deleteMock, saveManualMock } =
  vi.hoisted(() => ({
    state: {
      skills: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'my-skill',
          description: 'My instructions',
          content: '# My skill body',
          canManage: true,
          createdByName: 'Me',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'shared-skill',
          description: 'Another member created this',
          content: '# Shared skill body',
          canManage: false,
          createdByName: 'Teammate',
        },
      ],
      environments: [
        { id: '00000000-0000-4000-8000-000000000011', name: 'Alpha' },
        { id: '00000000-0000-4000-8000-000000000012', name: 'Beta' },
      ],
      createResult: null as Promise<{ success: true }> | null,
      isAdmin: false,
    },
    createMock: vi.fn(
      async (_input: unknown) =>
        state.createResult ?? Promise.resolve({ success: true as const }),
    ),
    updateMock: vi.fn(async (_input: unknown) => ({ success: true })),
    deleteMock: vi.fn(async (_input: unknown) => ({ success: true })),
    saveManualMock: vi.fn(async (_input: unknown) => ({ success: true })),
  }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    instanceSkills: {
      pathKey: () => ['instanceSkills'],
      list: {
        queryOptions: () => ({
          queryKey: ['instanceSkills', 'list'],
          queryFn: async () => state.skills,
        }),
      },
      create: {
        mutationOptions: (options = {}) => ({
          mutationFn: createMock,
          ...options,
        }),
      },
      update: {
        mutationOptions: (options = {}) => ({
          mutationFn: updateMock,
          ...options,
        }),
      },
      delete: {
        mutationOptions: (options = {}) => ({
          mutationFn: deleteMock,
          ...options,
        }),
      },
    },
    customSkills: {
      list: {
        queryKey: () => ['customSkills', 'list'],
        queryOptions: () => ({
          queryKey: ['customSkills', 'list'],
          queryFn: async () => ({
            deploymentName: 'this deployment',
            environments: state.environments,
            installed: [],
          }),
        }),
      },
      saveManual: {
        mutationOptions: (options = {}) => ({
          mutationFn: saveManualMock,
          ...options,
        }),
      },
    },
  }),
}));
vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));
vi.mock('@/components/settings/SettingsShell', () => ({
  SettingsShell: ({
    children,
    headerAction,
  }: {
    children: React.ReactNode;
    headerAction?: React.ReactNode;
  }) => (
    <>
      <header>{headerAction}</header>
      {children}
    </>
  ),
}));
vi.mock('@/components/settings/CustomSkills', () => ({
  CustomSkills: ({
    filter,
    search,
    marketplaceOpen,
    onMarketplaceOpenChange,
  }: {
    filter: string;
    search: string;
    marketplaceOpen: boolean;
    onMarketplaceOpenChange: (open: boolean) => void;
  }) => (
    <>
      {filter !== 'shared' && 'env-skill'.includes(search.toLowerCase()) ? (
        <div role="row" data-testid="environment-skill-row">
          <span role="cell">env-skill</span>
          <span role="cell">Environment instructions</span>
          <span role="cell">Only in Alpha</span>
        </div>
      ) : null}
      {marketplaceOpen ? (
        <div role="dialog" aria-label="Add from Marketplace">
          Marketplace results
          <button onClick={() => onMarketplaceOpenChange(false)}>Close</button>
        </div>
      ) : null}
    </>
  ),
}));

import { SkillsSettingsPage } from './pages/SkillsSettingsPage';
import { getAccessibleSettingsNavigation } from './settings-navigation';

function renderSkills() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <SkillsSettingsPage />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.createResult = null;
  state.isAdmin = false;
});

it('makes Skills navigation and creation available to members without environment selection', async () => {
  expect(
    getAccessibleSettingsNavigation({
      isAdmin: false,
      cloudEnabled: true,
      brainConfigured: false,
    }).some((item) => item.id === 'skills'),
  ).toBe(true);
  const { invalidate } = renderSkills();
  await screen.findByText('my-skill');
  expect(
    screen.queryByText(/marketplace|environment/i),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Add Custom Skill' }),
  ).toBeVisible();
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Add Custom Skill' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole('radio', { name: 'Everywhere' }),
  ).toBeChecked();
  expect(
    within(dialog).queryByText('Only in selected environments'),
  ).not.toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Slug'), {
    target: { value: 'new-skill' },
  });
  fireEvent.change(within(dialog).getByLabelText('Description'), {
    target: { value: 'When to use it' },
  });
  fireEvent.change(within(dialog).getByLabelText('Content'), {
    target: { value: '# Instructions' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Skill' }));
  await waitFor(() => expect(createMock).toHaveBeenCalled());
  expect(createMock.mock.calls[0]?.[0]).toEqual({
    name: 'new-skill',
    description: 'When to use it',
    content: '# Instructions\n',
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['instanceSkills'] }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
});

it('lets members view every body but only manage skills authorized by the server', async () => {
  renderSkills();
  await screen.findByText('my-skill');
  const table = screen.getByRole('table', { name: 'Skills' });
  expect(within(table).getByText('Created by Me')).toBeInTheDocument();
  expect(within(table).getByText('Created by Teammate')).toBeInTheDocument();
  expect(within(table).getAllByText('Everywhere')).toHaveLength(2);
  expect(
    within(table).getByRole('button', { name: 'Edit my-skill' }),
  ).toBeInTheDocument();
  expect(
    within(table).getByRole('button', { name: 'Delete my-skill' }),
  ).toBeInTheDocument();
  expect(
    within(table).queryByRole('button', { name: 'Edit shared-skill' }),
  ).not.toBeInTheDocument();
  expect(
    within(table).queryByRole('button', { name: 'Delete shared-skill' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('my-skill'));
  const ownedDialog = screen.getByRole('dialog');
  expect(within(ownedDialog).getByText('# My skill body')).toBeInTheDocument();
  fireEvent.click(
    within(ownedDialog).getAllByRole('button', { name: 'Close' })[0]!,
  );
  fireEvent.click(screen.getByText('shared-skill'));
  expect(
    within(screen.getByRole('dialog')).getByText('# Shared skill body'),
  ).toBeInTheDocument();
});

it('shows document-size validation instead of silently refusing to save', async () => {
  renderSkills();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit my-skill' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Content'), {
    target: { value: 'x'.repeat(64 * 1024) },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Skill' }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('64 KiB')),
  );
  expect(updateMock).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('keeps the submitted catalog invalidation stable while creation is pending', async () => {
  let resolveCreate!: (value: { success: true }) => void;
  state.createResult = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const { invalidate } = renderSkills();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Add Custom Skill' }),
  );
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Slug'), {
    target: { value: 'pending-skill' },
  });
  fireEvent.change(within(dialog).getByLabelText('Description'), {
    target: { value: 'Pending instructions' },
  });
  fireEvent.change(within(dialog).getByLabelText('Content'), {
    target: { value: '# Pending instructions' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Skill' }));

  await waitFor(() => expect(createMock).toHaveBeenCalled());
  expect(
    within(dialog).getByRole('radio', { name: 'Everywhere' }),
  ).toBeDisabled();
  resolveCreate({ success: true });

  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['instanceSkills'] }),
  );
  expect(invalidate).not.toHaveBeenCalledWith({
    queryKey: ['customSkills', 'list'],
  });
});

it('updates a creator skill and invalidates the catalog', async () => {
  const { invalidate } = renderSkills();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit my-skill' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Content')).toHaveValue(
    '# My skill body',
  );
  fireEvent.change(within(dialog).getByLabelText('Content'), {
    target: { value: '# Updated body' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save Skill' }));
  await waitFor(() => expect(updateMock).toHaveBeenCalled());
  expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
    skillId: state.skills[0]!.id,
    content: '# Updated body\n',
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['instanceSkills'] }),
  );
});

it('requires confirmation before deleting and refreshes the catalog', async () => {
  const { invalidate } = renderSkills();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Delete my-skill' }),
  );
  expect(deleteMock).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
  );
  expect(deleteMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete my-skill' }));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Delete Skill',
    }),
  );
  await waitFor(() => expect(deleteMock).toHaveBeenCalled());
  expect(deleteMock.mock.calls[0]?.[0]).toEqual({
    skillId: state.skills[0]!.id,
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['instanceSkills'] }),
  );
});

it('unifies admin skills with filters, search, marketplace, and scoped creation', async () => {
  state.isAdmin = true;
  renderSkills();
  await screen.findByText('my-skill');
  const table = screen.getByRole('table', { name: 'Skills' });
  expect(
    within(table).getByRole('columnheader', { name: 'Availability' }),
  ).toBeVisible();
  expect(within(table).getByText('Only in Alpha')).toBeVisible();
  expect(within(table).getAllByText('Everywhere')).toHaveLength(2);
  expect(screen.getAllByRole('radio')).toHaveLength(3);

  fireEvent.click(screen.getByRole('radio', { name: 'Everywhere' }));
  expect(screen.queryByText('env-skill')).not.toBeInTheDocument();
  expect(screen.getByText('my-skill')).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: 'Env-Specific' }));
  expect(screen.getByText('env-skill')).toBeVisible();
  expect(screen.queryByText('my-skill')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'All' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search skills' }), {
    target: { value: 'env-skill' },
  });
  expect(screen.getByText('env-skill')).toBeVisible();
  expect(screen.queryByText('my-skill')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Add from Marketplace' }));
  expect(
    screen.getByRole('dialog', { name: 'Add from Marketplace' }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  fireEvent.click(screen.getByRole('button', { name: 'Add Custom Skill' }));
  const createDialog = screen.getByRole('dialog');
  const environmentScope = await within(createDialog).findByRole('radio', {
    name: 'Only in selected environments',
  });
  await waitFor(() => expect(environmentScope).toBeEnabled());
  fireEvent.click(environmentScope);
  fireEvent.click(await within(createDialog).findByLabelText('Alpha'));
  fireEvent.change(within(createDialog).getByLabelText('Slug'), {
    target: { value: 'environment-skill' },
  });
  fireEvent.change(within(createDialog).getByLabelText('Description'), {
    target: { value: 'Environment instructions' },
  });
  fireEvent.change(within(createDialog).getByLabelText('Content'), {
    target: { value: '# Environment instructions' },
  });
  fireEvent.click(
    within(createDialog).getByRole('button', { name: 'Save Skill' }),
  );
  await waitFor(() =>
    expect(saveManualMock).toHaveBeenCalledWith(
      {
        name: 'environment-skill',
        description: 'Environment instructions',
        content: '# Environment instructions\n',
        environmentIds: ['00000000-0000-4000-8000-000000000011'],
      },
      expect.anything(),
    ),
  );
});
