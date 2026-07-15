import { useEffect } from 'react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { render, waitFor } from '@testing-library/react';

import type { CreateTaskFormValues } from '@/types';

import { AUTO_WORKSPACE_VALUE } from './constants';
import { SelectEnvironmentOrRepository } from './SelectEnvironmentOrRepository';

vi.mock('@/hooks/environments', () => ({
  useEnvironments: vi.fn(),
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

import { useEnvironments } from '@/hooks/environments';
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
  repositoryFilter = REPOSITORY,
  defaultValues,
  onValuesChange,
}: {
  allowAuto?: boolean;
  repositoryFilter?: string;
  defaultValues: Partial<CreateTaskFormValues>;
  onValuesChange: (values: WorkspaceSelectionValues) => void;
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
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </FormProvider>
  );
};

describe('SelectEnvironmentOrRepository', () => {
  const mockedUseEnvironments = vi.mocked(useEnvironments);
  const mockedUseRepositories = vi.mocked(useRepositories);
  const mockedUseAuthorizedUser = vi.mocked(useAuthorizedUser);
  const mockedUseWorkspaceStorage = vi.mocked(useWorkspaceStorage);
  const setWorkspace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockedUseAuthorizedUser.mockReturnValue({
      isAdmin: false,
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
  });

  it('auto-selects the matching environment for repository-filtered flows when repository is prefilled', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
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

  it('preserves prefilled repository in auto mode instead of force-selecting an environment', async () => {
    let latestValues: WorkspaceSelectionValues | undefined;

    render(
      <SelectEnvironmentOrRepositoryHarness
        allowAuto
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
        repositoryFilter={undefined}
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
        repositoryFilter={undefined}
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
});
