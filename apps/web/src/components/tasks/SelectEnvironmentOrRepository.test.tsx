import { useEffect } from 'react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { act, render, screen, waitFor } from '@testing-library/react';

import type { CreateTaskFormValues } from '@/types';

import { FAST_EXECUTION } from '@roomote/types';

import { AUTO_WORKSPACE_VALUE } from './constants';
import { SelectEnvironmentOrRepository } from './SelectEnvironmentOrRepository';

vi.mock('@/hooks/environments', () => ({
  useEnvironments: vi.fn(),
  useAvailableEnvironments: vi.fn(),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: vi.fn(),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: vi.fn(),
}));

vi.mock('@/hooks/useWorkspaceStorage', () => ({
  useWorkspaceStorage: vi.fn(),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    DropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="dropdown-menu">{children}</div>
    ),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="dropdown-menu-trigger">{children}</div>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="dropdown-menu-content">{children}</div>
    ),
    DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="dropdown-menu-group">{children}</div>
    ),
    DropdownMenuLabel: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => (
      <div data-slot="dropdown-menu-label" className={className}>
        {children}
      </div>
    ),
    DropdownMenuItem: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => (
      <div data-slot="dropdown-menu-item" className={className}>
        {children}
      </div>
    ),
    DropdownMenuSeparator: () => <div data-slot="dropdown-menu-separator" />,
  };
});

import {
  useAvailableEnvironments,
  useEnvironments,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useWorkspaceStorage } from '@/hooks/useWorkspaceStorage';

const REPOSITORY = 'Roomote/example-app';
const DEFAULT_VALUES: CreateTaskFormValues = {
  repository: '',
  branch: '',
  environmentId: undefined,
  text: '',
  images: [],
  port: undefined,
};

type WorkspaceSelectionValues = Pick<
  CreateTaskFormValues,
  'repository' | 'environmentId' | 'branch'
>;

const WorkspaceValuesProbe = ({
  onChange,
}: {
  onChange: (values: WorkspaceSelectionValues) => void;
}) => {
  const { watch } = useFormContext<CreateTaskFormValues>();
  const repository = watch('repository');
  const environmentId = watch('environmentId');
  const branch = watch('branch');

  useEffect(() => {
    onChange({ repository, environmentId, branch });
  }, [branch, environmentId, onChange, repository]);

  return null;
};

const SelectEnvironmentOrRepositoryHarness = ({
  allowAuto = false,
  allowFast = false,
  autoSelectDefaultWorkspace = true,
  repositoryFilter,
  defaultValues,
  onValuesChange,
  onInvalidWorkspaceReset,
  onCreateRepository,
}: {
  allowAuto?: boolean;
  allowFast?: boolean;
  autoSelectDefaultWorkspace?: boolean;
  /** Omit for no filter (homepage Auto). Pass a repo full name to filter. */
  repositoryFilter?: string;
  defaultValues: Partial<CreateTaskFormValues>;
  onValuesChange: (values: WorkspaceSelectionValues) => void;
  onInvalidWorkspaceReset?: () => void;
  onCreateRepository?: () => void;
}) => {
  const form = useForm<CreateTaskFormValues>({
    defaultValues: {
      ...DEFAULT_VALUES,
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...form}>
      <WorkspaceValuesProbe onChange={onValuesChange} />
      <SelectEnvironmentOrRepository
        repositoryFilter={repositoryFilter}
        allowAuto={allowAuto}
        allowFast={allowFast}
        autoSelectDefaultWorkspace={autoSelectDefaultWorkspace}
        onInvalidWorkspaceReset={onInvalidWorkspaceReset}
        onCreate={vi.fn()}
        onCreateRepository={onCreateRepository}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </FormProvider>
  );
};

describe('SelectEnvironmentOrRepository', () => {
  const mockedUseEnvironments = vi.mocked(useEnvironments);
  const mockedUseAvailableEnvironments = vi.mocked(useAvailableEnvironments);
  const mockedUseRepositories = vi.mocked(useRepositories);
  const mockedUseAuthorizedUser = vi.mocked(useAuthorizedUser);
  const mockedUseWorkspaceStorage = vi.mocked(useWorkspaceStorage);
  const setWorkspace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockedUseAuthorizedUser.mockReturnValue({
      isAdmin: true,
    } as ReturnType<typeof useAuthorizedUser>);

    mockedUseWorkspaceStorage.mockReturnValue({
      workspace: { workspace: { type: 'auto' } },
      setWorkspace,
    } as ReturnType<typeof useWorkspaceStorage>);

    mockedUseRepositories.mockReturnValue({
      data: [{ fullName: REPOSITORY, name: 'Roomote' }],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useRepositories>);

    mockedUseEnvironments.mockReturnValue({
      data: [
        {
          id: 'env_123',
          name: 'Roomote',
          config: {
            repositories: [{ repository: REPOSITORY }],
          },
        },
      ],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useEnvironments>);
    mockedUseAvailableEnvironments.mockReturnValue({
      data: [{ id: 'env_123', name: 'Roomote' }],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useAvailableEnvironments>);
  });

  it('auto-selects the matching environment for repository-filtered flows when repository is prefilled', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        repositoryFilter={REPOSITORY}
        defaultValues={{ repository: REPOSITORY }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.environmentId).toBe('env_123');
    });

    expect(latestValues).toMatchObject({
      environmentId: 'env_123',
      repository: 'env_123',
      branch: '',
    });
    expect(setWorkspace).toHaveBeenCalledWith({
      workspace: { type: 'environment', id: 'env_123' },
    });
  });

  it('uses the Member-safe environment result without configuration data', async () => {
    mockedUseAuthorizedUser.mockReturnValue({
      isAdmin: false,
    } as ReturnType<typeof useAuthorizedUser>);
    mockedUseAvailableEnvironments.mockReturnValue({
      data: [{ id: 'env_member', name: 'Member environment' }],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useAvailableEnvironments>);

    render(
      <SelectEnvironmentOrRepositoryHarness
        defaultValues={{}}
        onValuesChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Member environment')).toHaveLength(2);
    expect(screen.getByText(/Environments.*recommended/)).toBeInTheDocument();
  });

  it('keeps a Fast selection instead of resetting it to Auto', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        allowFast
        defaultValues={{ repository: FAST_EXECUTION }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    // Rendered both as the selected trigger label and as the menu item.
    expect(screen.getAllByText('Fast')).toHaveLength(2);

    await waitFor(() => {
      expect(latestValues?.repository).toBe(FAST_EXECUTION);
    });
    expect(latestValues).toMatchObject({
      environmentId: undefined,
      repository: FAST_EXECUTION,
    });
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('preserves prefilled repository in auto mode instead of force-selecting an environment', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        repositoryFilter={REPOSITORY}
        defaultValues={{ repository: REPOSITORY }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.repository).toBe(REPOSITORY);
    });

    expect(latestValues).toMatchObject({
      environmentId: undefined,
      repository: REPOSITORY,
      branch: '',
    });
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('defaults Auto mode to the sole environment when only one is configured', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.environmentId).toBe('env_123');
    });

    expect(latestValues).toMatchObject({
      environmentId: 'env_123',
      repository: 'env_123',
      branch: '',
    });
    expect(setWorkspace).toHaveBeenCalledWith({
      workspace: { type: 'environment', id: 'env_123' },
    });
  });

  it('leaves Auto unchanged when default workspace selection is deferred', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        autoSelectDefaultWorkspace={false}
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.repository).toBe(AUTO_WORKSPACE_VALUE);
    });
    expect(latestValues?.environmentId).toBeUndefined();
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('reports when an invalid persisted environment is reset', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;
    const onInvalidWorkspaceReset = vi.fn();

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        autoSelectDefaultWorkspace={false}
        defaultValues={{
          repository: 'env-stale',
          environmentId: 'env-stale',
        }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
        onInvalidWorkspaceReset={onInvalidWorkspaceReset}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.repository).toBe(AUTO_WORKSPACE_VALUE);
      expect(latestValues?.environmentId).toBeUndefined();
    });
    expect(onInvalidWorkspaceReset).toHaveBeenCalledOnce();
  });

  it('re-defaults to the sole environment after a programmatic reset backs out to Auto', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;
    let setFormValues:
      | ((values: Partial<CreateTaskFormValues>) => void)
      | undefined;

    const FormControlHarness = ({
      onValuesChange,
    }: {
      onValuesChange: (values: WorkspaceSelectionValues) => void;
    }) => {
      const form = useForm<CreateTaskFormValues>({
        defaultValues: {
          ...DEFAULT_VALUES,
          repository: AUTO_WORKSPACE_VALUE,
        },
      });

      setFormValues = (values) => {
        if (values.repository !== undefined) {
          form.setValue('repository', values.repository);
        }
        if (values.environmentId !== undefined) {
          form.setValue('environmentId', values.environmentId);
        }
        if (values.branch !== undefined) {
          form.setValue('branch', values.branch);
        }
        if (
          values.environmentId === undefined &&
          Object.prototype.hasOwnProperty.call(values, 'environmentId')
        ) {
          form.setValue('environmentId', undefined);
        }
      };

      return (
        <FormProvider {...form}>
          <WorkspaceValuesProbe onChange={onValuesChange} />
          <SelectEnvironmentOrRepository
            allowAuto
            onCreate={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
          />
        </FormProvider>
      );
    };

    render(
      <FormControlHarness
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.environmentId).toBe('env_123');
    });

    act(() => {
      setFormValues?.({
        repository: AUTO_WORKSPACE_VALUE,
        environmentId: undefined,
        branch: '',
      });
    });

    await waitFor(() => {
      expect(latestValues?.environmentId).toBe('env_123');
      expect(latestValues?.repository).toBe('env_123');
    });
  });

  it('defaults Auto to the sole environment after the list goes from empty to one', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    mockedUseEnvironments.mockReturnValue({
      data: [] as Array<{
        id: string;
        name: string;
        config: { repositories: Array<{ repository: string }> };
      }>,
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useEnvironments>);

    const { rerender } = render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.repository).toBe(AUTO_WORKSPACE_VALUE);
      expect(latestValues?.environmentId).toBeUndefined();
    });
    expect(setWorkspace).not.toHaveBeenCalled();

    mockedUseEnvironments.mockReturnValue({
      data: [
        {
          id: 'env_after_setup',
          name: 'Roomote',
          config: {
            repositories: [{ repository: REPOSITORY }],
          },
        },
      ],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useEnvironments>);

    rerender(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.environmentId).toBe('env_after_setup');
    });

    expect(latestValues).toMatchObject({
      environmentId: 'env_after_setup',
      repository: 'env_after_setup',
      branch: '',
    });
    expect(setWorkspace).toHaveBeenCalledWith({
      workspace: { type: 'environment', id: 'env_after_setup' },
    });
  });

  it('keeps Auto when multiple environments are configured', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    mockedUseEnvironments.mockReturnValue({
      data: [
        {
          id: 'env_123',
          name: 'Alpha',
          config: {
            repositories: [{ repository: REPOSITORY }],
          },
        },
        {
          id: 'env_456',
          name: 'Beta',
          config: {
            repositories: [{ repository: REPOSITORY }],
          },
        },
      ],
      isPending: false,
      isSuccess: true,
    } as ReturnType<typeof useEnvironments>);

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
        onValuesChange={(values) => {
          latestValues = values;
        }}
      />,
    );

    await waitFor(() => {
      expect(latestValues?.repository).toBe(AUTO_WORKSPACE_VALUE);
    });

    expect(latestValues).toMatchObject({
      environmentId: undefined,
      repository: AUTO_WORKSPACE_VALUE,
      branch: '',
    });
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('renders Auto in its own section below All Repositories', async () => {
    mockedUseAuthorizedUser.mockReturnValue({
      isAdmin: true,
    } as ReturnType<typeof useAuthorizedUser>);

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
        repositoryFilter={REPOSITORY}
        defaultValues={{}}
        onValuesChange={vi.fn()}
      />,
    );

    const dropdownContent = document.querySelector(
      '[data-slot="dropdown-menu-content"]',
    );

    expect(dropdownContent).not.toBeNull();

    const menuSequence = Array.from(
      dropdownContent!.querySelectorAll(
        '[data-slot="dropdown-menu-item"], [data-slot="dropdown-menu-separator"]',
      ),
    ).map((node) =>
      node.getAttribute('data-slot') === 'dropdown-menu-separator'
        ? '__separator__'
        : node.textContent?.trim(),
    );

    expect(menuSequence.slice(-3)).toEqual([
      'All Repositories',
      '__separator__',
      'Auto',
    ]);
  });

  it('offers the New GitHub repository item to admins when wired up', async () => {
    render(
      <SelectEnvironmentOrRepositoryHarness
        defaultValues={{}}
        onValuesChange={vi.fn()}
        onCreateRepository={vi.fn()}
      />,
    );

    const menuItems = Array.from(
      document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    ).map((node) => node.textContent?.trim());

    expect(menuItems).toContain('Create environment');
    expect(menuItems).toContain('New GitHub repository');
  });

  it('hides the New GitHub repository item without a handler or admin rights', async () => {
    const { unmount } = render(
      <SelectEnvironmentOrRepositoryHarness
        defaultValues={{}}
        onValuesChange={vi.fn()}
      />,
    );

    const menuItemsWithoutHandler = Array.from(
      document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    ).map((node) => node.textContent?.trim());
    expect(menuItemsWithoutHandler).not.toContain('New GitHub repository');
    unmount();

    mockedUseAuthorizedUser.mockReturnValue({
      isAdmin: false,
    } as ReturnType<typeof useAuthorizedUser>);

    render(
      <SelectEnvironmentOrRepositoryHarness
        defaultValues={{}}
        onValuesChange={vi.fn()}
        onCreateRepository={vi.fn()}
      />,
    );

    const menuItemsAsMember = Array.from(
      document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    ).map((node) => node.textContent?.trim());
    expect(menuItemsAsMember).not.toContain('New GitHub repository');
  });
});
