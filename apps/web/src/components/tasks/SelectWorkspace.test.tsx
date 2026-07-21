import { FormProvider, useForm } from 'react-hook-form';
import { render, screen } from '@testing-library/react';

import { ALL_REPOSITORIES } from '@roomote/types';

import type { CreateTaskFormValues } from '@/types';

import { AUTO_WORKSPACE_VALUE } from './constants';
import { SelectWorkspace } from './SelectWorkspace';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/settings/environments', () => ({
  DeleteEnvironmentDialog: () => null,
}));

vi.mock('./SelectEnvironmentOrRepository', () => ({
  SelectEnvironmentOrRepository: ({
    showRepositories,
  }: {
    showRepositories?: boolean;
  }) => (
    <div
      data-testid="workspace-picker"
      data-show-repositories={showRepositories}
    >
      Workspace picker
    </div>
  ),
}));

vi.mock('./SelectBranch', () => ({
  SelectBranch: ({
    repositoryFullName,
    defaultBranch,
  }: {
    repositoryFullName?: string;
    defaultBranch?: string;
  }) => (
    <div
      data-testid="branch-selector"
      data-repository={repositoryFullName ?? ''}
      data-default-branch={defaultBranch ?? ''}
    />
  ),
}));

const DEFAULT_VALUES: CreateTaskFormValues = {
  repository: AUTO_WORKSPACE_VALUE,
  branch: '',
  environmentId: undefined,
  text: '',
  images: [],
  port: undefined,
};

const SelectWorkspaceHarness = ({
  defaultValues,
  allowBranchSelection,
  showRepositories,
  environmentBranchRepositoryFullName,
  environmentBranchDefault,
}: {
  defaultValues: Partial<CreateTaskFormValues>;
  allowBranchSelection?: boolean;
  showRepositories?: boolean;
  environmentBranchRepositoryFullName?: string;
  environmentBranchDefault?: string;
}) => {
  const form = useForm<CreateTaskFormValues>({
    defaultValues: {
      ...DEFAULT_VALUES,
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...form}>
      <SelectWorkspace
        allowBranchSelection={allowBranchSelection}
        showRepositories={showRepositories}
        environmentBranchRepositoryFullName={
          environmentBranchRepositoryFullName
        }
        environmentBranchDefault={environmentBranchDefault}
      />
    </FormProvider>
  );
};

describe('SelectWorkspace', () => {
  it('only asks the workspace picker to show repositories when requested', () => {
    render(
      <SelectWorkspaceHarness
        showRepositories
        defaultValues={{ repository: AUTO_WORKSPACE_VALUE }}
      />,
    );

    expect(screen.getByTestId('workspace-picker')).toHaveAttribute(
      'data-show-repositories',
      'true',
    );
  });

  it('shows a branch selector for a selected single-repo environment', () => {
    render(
      <SelectWorkspaceHarness
        defaultValues={{
          repository: 'env-single',
          environmentId: 'env-single',
        }}
        environmentBranchRepositoryFullName="Roomote/example-app"
        environmentBranchDefault="develop"
      />,
    );

    const selector = screen.getByTestId('branch-selector');

    expect(selector).toHaveAttribute('data-repository', 'Roomote/example-app');
    expect(selector).toHaveAttribute('data-default-branch', 'develop');
  });

  it('hides branch selectors when branch selection is disabled', () => {
    render(
      <SelectWorkspaceHarness
        allowBranchSelection={false}
        defaultValues={{
          repository: 'env-single',
          environmentId: 'env-single',
        }}
        environmentBranchRepositoryFullName="Roomote/example-app"
        environmentBranchDefault="develop"
      />,
    );

    expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();
  });

  it('does not show a branch selector for multi-repo environments', () => {
    render(
      <SelectWorkspaceHarness
        defaultValues={{
          repository: 'env-multi',
          environmentId: 'env-multi',
        }}
      />,
    );

    expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();
  });

  it('keeps showing the repository branch selector for direct repo launches', () => {
    render(
      <SelectWorkspaceHarness
        defaultValues={{
          repository: 'Roomote/example-app',
          environmentId: undefined,
        }}
      />,
    );

    expect(screen.getByTestId('branch-selector')).toHaveAttribute(
      'data-repository',
      '',
    );
  });

  it('does not show a branch selector for all repositories or auto', () => {
    const { unmount } = render(
      <SelectWorkspaceHarness
        defaultValues={{
          repository: ALL_REPOSITORIES,
          environmentId: undefined,
        }}
      />,
    );

    expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();

    unmount();

    render(
      <SelectWorkspaceHarness
        defaultValues={{
          repository: AUTO_WORKSPACE_VALUE,
          environmentId: undefined,
        }}
      />,
    );

    expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();
  });
});
