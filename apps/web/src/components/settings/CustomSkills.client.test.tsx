import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
  TextareaHTMLAttributes,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type InstalledSkill = {
  kind: 'manual' | 'marketplace';
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: string | null;
  environments: Array<{ id: string; name: string }>;
};

type ListData = {
  organizationName: string;
  environments: Array<{ id: string; name: string }>;
  installed: InstalledSkill[];
};

const {
  state,
  setAvailabilityMock,
  saveManualMock,
  removeMock,
  searchQueryMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  buildManualSkillId: (skillName: string, variant = '1234567890ab') =>
    `manual@${skillName}#${variant}`,
  state: {
    listData: {
      organizationName: 'Test Org',
      environments: [
        { id: 'env-1', name: 'Alpha' },
        { id: 'env-2', name: 'Beta' },
      ],
      installed: [
        {
          kind: 'marketplace' as const,
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: null,
          url: null,
          description: null,
          content: null,
          environments: [{ id: 'env-1', name: 'Alpha' }],
        },
      ],
    } as ListData,
    searchResultsByQuery: {
      react: [
        {
          kind: 'marketplace' as const,
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: '321.4K installs',
          url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
          description: null,
          content: null,
        },
        {
          kind: 'marketplace' as const,
          source: 'google-labs-code/stitch-skills',
          name: 'react:components',
          skillId: 'google-labs-code/stitch-skills@react:components',
          isAllSelection: false,
          installsLabel: '36.4K installs',
          url: 'https://skills.sh/google-labs-code/stitch-skills/react:components',
          description: null,
          content: null,
        },
      ],
    } as Record<
      string,
      Array<{
        kind: 'marketplace';
        source: string;
        name: string;
        skillId: string;
        isAllSelection: boolean;
        installsLabel: string | null;
        url: string | null;
        description: string | null;
        content: null;
      }>
    >,
  },
  setAvailabilityMock: vi.fn(
    async (input: { skillId: string; environmentIds: string[] }) => {
      const existing = state.listData.installed.find(
        (entry) => entry.skillId === input.skillId,
      );
      const fromSearch = Object.values(state.searchResultsByQuery)
        .flat()
        .find((entry) => entry.skillId === input.skillId);

      const base = existing ?? fromSearch;

      if (base) {
        const nextInstalledEntry: InstalledSkill = {
          kind: base.kind,
          source: base.source,
          name: base.name,
          skillId: base.skillId,
          isAllSelection: base.isAllSelection,
          installsLabel: null,
          url: base.url,
          description: base.description,
          content: base.content,
          environments: input.environmentIds
            .map((environmentId) =>
              state.listData.environments.find(
                (env) => env.id === environmentId,
              ),
            )
            .filter(
              (environment): environment is { id: string; name: string } =>
                Boolean(environment),
            )
            .sort((left, right) => left.name.localeCompare(right.name)),
        };

        state.listData.installed = [
          ...state.listData.installed.filter(
            (entry) => entry.skillId !== input.skillId,
          ),
          nextInstalledEntry,
        ].sort((left, right) => left.skillId.localeCompare(right.skillId));
      }

      return {
        success: true as const,
        updatedEnvironmentIds: input.environmentIds,
      };
    },
  ),
  saveManualMock: vi.fn(
    async (input: {
      name: string;
      description: string;
      content: string;
      environmentIds: string[];
      previousSkillId?: string;
    }) => {
      state.listData.installed = [
        ...state.listData.installed.filter(
          (entry) =>
            entry.kind !== 'manual' || entry.skillId !== input.previousSkillId,
        ),
        {
          kind: 'manual' as const,
          source: 'manual',
          name: input.name,
          skillId: `manual@${input.name}#1234567890ab`,
          isAllSelection: false,
          installsLabel: null,
          url: null,
          description: input.description,
          content: input.content,
          environments: input.environmentIds
            .map((environmentId) =>
              state.listData.environments.find(
                (env) => env.id === environmentId,
              ),
            )
            .filter(
              (environment): environment is { id: string; name: string } =>
                Boolean(environment),
            )
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
      ].sort((left, right) => left.skillId.localeCompare(right.skillId));

      return {
        success: true as const,
        skillId: `manual@${input.name}#1234567890ab`,
        updatedEnvironmentIds: input.environmentIds,
      };
    },
  ),
  removeMock: vi.fn(async (input: { skillId: string }) => {
    state.listData.installed = state.listData.installed.filter(
      (entry) => entry.skillId !== input.skillId,
    );

    return { success: true as const, updatedEnvironmentIds: ['env-1'] };
  }),
  searchQueryMock: vi.fn(
    async (query: string) => state.searchResultsByQuery[query] ?? [],
  ),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    customSkills: {
      list: {
        queryKey: () => ['customSkills', 'list'],
        queryOptions: () => ({
          queryKey: ['customSkills', 'list'],
          queryFn: async () => state.listData,
        }),
      },
      search: {
        queryKey: () => ['customSkills', 'search'],
        queryOptions: (
          input: { query: string },
          options: Record<string, unknown> = {},
        ) => ({
          queryKey: ['customSkills', 'search', input.query],
          queryFn: async () => searchQueryMock(input.query),
          ...options,
        }),
      },
      setAvailability: {
        mutationOptions: (options = {}) => ({
          mutationFn: setAvailabilityMock,
          ...options,
        }),
      },
      saveManual: {
        mutationOptions: (options = {}) => ({
          mutationFn: saveManualMock,
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

vi.mock('@/components/system', () => ({
  ArrowUpFromLine: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Button: ({
    children,
    asChild: _asChild,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  ChartColumnIncreasing: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & InputHTMLAttributes<HTMLInputElement>) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h4>{children}</h4>,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Search: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Settings2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Skeleton: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Spinner: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  SquareArrowOutUpRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  Trash2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  VectorSquare: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  X: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

import { CustomSkills } from './CustomSkills';

function renderCustomSkills() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CustomSkills />
    </QueryClientProvider>,
  );
}

describe('CustomSkills settings', () => {
  beforeEach(() => {
    vi.useRealTimers();
    setAvailabilityMock.mockClear();
    saveManualMock.mockClear();
    removeMock.mockClear();
    searchQueryMock.mockClear();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();

    state.listData = {
      organizationName: 'Test Org',
      environments: [
        { id: 'env-1', name: 'Alpha' },
        { id: 'env-2', name: 'Beta' },
      ],
      installed: [
        {
          kind: 'marketplace',
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: null,
          url: null,
          description: null,
          content: null,
          environments: [{ id: 'env-1', name: 'Alpha' }],
        },
      ],
    };
    state.searchResultsByQuery = {
      react: [
        {
          kind: 'marketplace',
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: '321.4K installs',
          url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
          description: null,
          content: null,
        },
        {
          kind: 'marketplace',
          source: 'google-labs-code/stitch-skills',
          name: 'react:components',
          skillId: 'google-labs-code/stitch-skills@react:components',
          isAllSelection: false,
          installsLabel: '36.4K installs',
          url: 'https://skills.sh/google-labs-code/stitch-skills/react:components',
          description: null,
          content: null,
        },
      ],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders installed skills and environment badges from list data', async () => {
    renderCustomSkills();

    await waitFor(() => {
      expect(
        screen.getByText('by vercel-labs/agent-skills'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('Installed')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Add a custom skill')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add a custom skill' }),
    ).toBeVisible();
  });

  it('debounces search input before rendering marketplace results', async () => {
    renderCustomSkills();

    const input = await screen.findByPlaceholderText(
      'Search by skill name or source',
    );

    fireEvent.change(input, { target: { value: 'react' } });

    expect(screen.queryByText('react:components')).not.toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.getByText('react:components')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByText('321.4K installs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Installed' })).toBeDisabled();
  });

  it('supports multi-environment availability updates', async () => {
    renderCustomSkills();

    const input = await screen.findByPlaceholderText(
      'Search by skill name or source',
    );
    fireEvent.change(input, { target: { value: 'react' } });

    await waitFor(
      () => {
        expect(screen.getByText('react:components')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    const alphaCheckbox = await screen.findByLabelText('Alpha');
    const betaCheckbox = await screen.findByLabelText('Beta');

    fireEvent.click(alphaCheckbox);
    fireEvent.click(betaCheckbox);
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!);

    await waitFor(() => {
      expect(setAvailabilityMock.mock.calls[0]?.[0]).toEqual({
        skillId: 'google-labs-code/stitch-skills@react:components',
        environmentIds: ['env-1', 'env-2'],
      });
    });
  });

  it('keeps marketplace results installable when another environment uses source: all', async () => {
    state.listData.installed = [
      {
        kind: 'marketplace' as const,
        source: 'vercel-labs/agent-skills',
        name: '*',
        skillId: 'vercel-labs/agent-skills@*',
        isAllSelection: true,
        installsLabel: null,
        url: null,
        description: null,
        content: null,
        environments: [{ id: 'env-1', name: 'Alpha' }],
      },
    ];
    state.searchResultsByQuery = {
      react: [
        {
          kind: 'marketplace' as const,
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: '321.4K installs',
          url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
          description: null,
          content: null,
        },
      ],
    };

    renderCustomSkills();

    const input = await screen.findByPlaceholderText(
      'Search by skill name or source',
    );
    fireEvent.change(input, { target: { value: 'react' } });

    const installButton = await screen.findByRole('button', {
      name: 'Install',
    });

    expect(installButton).toBeEnabled();

    fireEvent.click(installButton);

    const alphaCheckbox = await screen.findByLabelText('Alpha');
    const betaCheckbox = await screen.findByLabelText('Beta');

    expect(alphaCheckbox).toBeChecked();
    expect(alphaCheckbox).toBeDisabled();
    expect(betaCheckbox).not.toBeChecked();
    expect(betaCheckbox).toBeEnabled();

    fireEvent.click(betaCheckbox);
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!);

    await waitFor(() => {
      expect(setAvailabilityMock.mock.calls[0]?.[0]).toEqual({
        skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
        environmentIds: ['env-2'],
      });
    });
  });

  it('shows Installed when source: all already covers every environment', async () => {
    state.listData.installed = [
      {
        kind: 'marketplace' as const,
        source: 'vercel-labs/agent-skills',
        name: '*',
        skillId: 'vercel-labs/agent-skills@*',
        isAllSelection: true,
        installsLabel: null,
        url: null,
        description: null,
        content: null,
        environments: [
          { id: 'env-1', name: 'Alpha' },
          { id: 'env-2', name: 'Beta' },
        ],
      },
    ];
    state.searchResultsByQuery = {
      react: [
        {
          kind: 'marketplace' as const,
          source: 'vercel-labs/agent-skills',
          name: 'vercel-react-best-practices',
          skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
          isAllSelection: false,
          installsLabel: '321.4K installs',
          url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
          description: null,
          content: null,
        },
      ],
    };

    renderCustomSkills();

    const input = await screen.findByPlaceholderText(
      'Search by skill name or source',
    );
    fireEvent.change(input, { target: { value: 'react' } });

    const installedButton = await screen.findByRole('button', {
      name: 'Installed',
    });

    expect(installedButton).toBeDisabled();
  });

  it('lets users add a manual skill with separate fields', async () => {
    renderCustomSkills();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Add a custom skill' }),
    );

    fireEvent.change(screen.getByLabelText('Manual skill slug'), {
      target: { value: 'my manual/skill' },
    });
    fireEvent.change(screen.getByLabelText('Manual skill description'), {
      target: { value: 'Manual skill.' },
    });
    fireEvent.change(screen.getByLabelText('Manual skill content'), {
      target: {
        value: '# My Manual Skill',
      },
    });

    fireEvent.click(screen.getByLabelText('Alpha'));
    fireEvent.click(screen.getByLabelText('Beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Skill' }));

    await waitFor(() => {
      expect(saveManualMock.mock.calls[0]?.[0]).toEqual({
        name: 'mymanualskill',
        description: 'Manual skill.',
        content: '# My Manual Skill',
        environmentIds: ['env-1', 'env-2'],
        previousSkillId: undefined,
      });
    });
  });

  it('opens installed manual skills in the manual editor', async () => {
    state.listData.installed = [
      {
        kind: 'manual' as const,
        source: 'manual',
        name: 'my-manual-skill',
        skillId: 'manual@my-manual-skill#1234567890ab',
        isAllSelection: false,
        installsLabel: null,
        url: null,
        description: 'Manual skill',
        content: '# My Manual Skill\n',
        environments: [{ id: 'env-1', name: 'Alpha' }],
      },
    ];

    renderCustomSkills();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Edit my-manual-skill' }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit my-manual-skill' }),
    );

    expect(screen.getByLabelText('Manual skill slug')).toHaveValue(
      'my-manual-skill',
    );
    expect(screen.getByLabelText('Manual skill description')).toHaveValue(
      'Manual skill',
    );
    expect(screen.getByLabelText('Manual skill content')).toHaveValue(
      '# My Manual Skill\n',
    );
  });

  it('prompts before closing the manual editor with unsaved changes', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderCustomSkills();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Add a custom skill' }),
    );
    fireEvent.change(screen.getByLabelText('Manual skill description'), {
      target: { value: 'Changed description' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(confirmMock).toHaveBeenCalledWith(
      'Discard unsaved changes to this custom skill?',
    );
    expect(
      screen.getByLabelText('Manual skill description'),
    ).toBeInTheDocument();

    confirmMock.mockRestore();
  });

  it('toggles manual skill descriptions between clamped and expanded states', async () => {
    state.listData.installed = [
      {
        kind: 'manual',
        source: 'manual',
        name: 'my-manual-skill',
        skillId: 'manual@my-manual-skill#1234567890ab',
        isAllSelection: false,
        installsLabel: null,
        url: null,
        description:
          'This is a long manual skill description that should be expandable in the installed skills list. '.repeat(
            3,
          ),
        content: '# My Manual Skill\n',
        environments: [{ id: 'env-1', name: 'Alpha' }],
      },
    ];

    renderCustomSkills();

    const description = await screen.findByText(
      /This is a long manual skill description that should be expandable in the installed skills list\./,
    );

    expect(description).toHaveClass('line-clamp-2');

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(description).not.toHaveClass('line-clamp-2');
    expect(screen.getByRole('button', { name: 'Less' })).toBeVisible();
  });

  it('removes an installed skill from all environments', async () => {
    renderCustomSkills();

    await waitFor(() => {
      expect(
        screen.getByText('by vercel-labs/agent-skills'),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove vercel-labs/agent-skills@vercel-react-best-practices',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));

    await waitFor(() => {
      expect(removeMock.mock.calls[0]?.[0]).toEqual({
        skillId: 'vercel-labs/agent-skills@vercel-react-best-practices',
      });
    });

    expect(
      screen.getByText(
        'No custom skills installed yet. Roomote itself has mad skills though.',
      ),
    ).toBeInTheDocument();
  });
});
