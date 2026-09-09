import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

const { state, createMock, updateMock, deleteMock, installMarketplaceMock } =
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
      isAdmin: false,
    },
    createMock: vi.fn(async (_input: unknown) => ({ success: true })),
    updateMock: vi.fn(async (_input: unknown) => ({ success: true })),
    deleteMock: vi.fn(async (_input: unknown) => ({ success: true })),
    installMarketplaceMock: vi.fn(async (_input: unknown) => ({
      success: true,
    })),
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
      searchMarketplace: {
        queryOptions: (input: { query: string }, options = {}) => ({
          queryKey: ['instanceSkills', 'searchMarketplace', input],
          queryFn: async () =>
            input.query
              ? [
                  {
                    kind: 'marketplace',
                    source: 'owner/catalog',
                    name: 'marketplace-skill',
                    skillId: 'owner/catalog@marketplace-skill',
                    isAllSelection: false,
                    installsLabel: '1.2K installs',
                    url: 'https://skills.sh/owner/catalog/marketplace-skill',
                    description: null,
                    content: null,
                  },
                ]
              : [],
          ...options,
        }),
      },
      installMarketplace: {
        mutationOptions: (options = {}) => ({
          mutationFn: installMarketplaceMock,
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
  expect(screen.queryByText(/environment/i)).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Add Skill' })).toHaveLength(1);
  expect(
    within(screen.getByRole('banner')).getByRole('button', {
      name: 'Add Skill',
    }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Add Skill' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/environment/i)).not.toBeInTheDocument();
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
  const list = screen.getByRole('list', { name: 'Shared skills' });
  expect(within(list).getByText('Created by Me')).toBeInTheDocument();
  expect(within(list).getByText('Created by Teammate')).toBeInTheDocument();
  expect(
    within(list).getByRole('button', { name: 'Edit my-skill' }),
  ).toBeInTheDocument();
  expect(
    within(list).getByRole('button', { name: 'Delete my-skill' }),
  ).toBeInTheDocument();
  expect(
    within(list).queryByRole('button', { name: 'Edit shared-skill' }),
  ).not.toBeInTheDocument();
  expect(
    within(list).queryByRole('button', { name: 'Delete shared-skill' }),
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

it('searches and installs a marketplace skill globally without environment selection', async () => {
  const { invalidate } = renderSkills();
  fireEvent.click(await screen.findByText('Browse skill marketplace'));
  fireEvent.change(screen.getByLabelText('Search skill marketplace'), {
    target: { value: 'marketplace' },
  });
  const resultList = await screen.findByRole('list', {
    name: 'Marketplace skills',
  });
  expect(within(resultList).getByText(/owner\/catalog/)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText(/select.*environment/i)).not.toBeInTheDocument();
  fireEvent.click(within(resultList).getByRole('button', { name: 'Install' }));
  await waitFor(() => expect(installMarketplaceMock).toHaveBeenCalled());
  expect(installMarketplaceMock.mock.calls[0]?.[0]).toEqual({
    skillId: 'owner/catalog@marketplace-skill',
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['instanceSkills'] }),
  );
});

it('shows only shared skills for admins with one add action in the header', async () => {
  state.isAdmin = true;
  renderSkills();
  await screen.findByText('my-skill');
  expect(screen.getAllByRole('button', { name: 'Add Skill' })).toHaveLength(1);
  expect(
    within(screen.getByRole('banner')).getByRole('button', {
      name: 'Add Skill',
    }),
  ).toBeVisible();
  expect(screen.getByText('Browse skill marketplace')).toBeVisible();
  expect(screen.queryByText(/environment/i)).not.toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Shared skills' })).toBeVisible();
});
