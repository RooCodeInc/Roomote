import { useEffect } from 'react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { render, screen, waitFor } from '@testing-library/react';

import type { CreateCloudTask } from '@/types';

import { SelectBranch } from './SelectBranch';

vi.mock('@/hooks/github', () => ({
  useBranches: vi.fn(),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );
  const Icon = (props: React.ComponentProps<'svg'>) => <svg {...props} />;

  return {
    ...actual,
    Check: Icon,
    ChevronsUpDown: Icon,
    GitBranch: Icon,
    Loader2: Icon,
    Search: Icon,
    DropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
    }) => (
      <button type="button" data-testid="branch-item" onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <div data-testid="branch-separator" />,
  };
});

import { useBranches } from '@/hooks/github';

const DEFAULT_VALUES: CreateCloudTask = {
  repository: 'Roomote/example-app',
  branch: '',
  environmentId: undefined,
  text: '',
  images: [],
  port: undefined,
};

const branchNames = Array.from(
  { length: 150 },
  (_, index) => `feature/${String(index).padStart(3, '0')}`,
);

const SelectBranchHarness = ({
  defaultValues,
  defaultBranch,
  onBranchChange,
  repositoryFullName,
}: {
  defaultValues?: Partial<CreateCloudTask>;
  defaultBranch?: string;
  onBranchChange?: (branch: string | undefined) => void;
  repositoryFullName?: string;
}) => {
  const form = useForm<CreateCloudTask>({
    defaultValues: {
      ...DEFAULT_VALUES,
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...form}>
      <BranchValueProbe onBranchChange={onBranchChange} />
      <SelectBranch
        defaultBranch={defaultBranch}
        repositoryFullName={repositoryFullName}
      />
    </FormProvider>
  );
};

const BranchValueProbe = ({
  onBranchChange,
}: {
  onBranchChange?: (branch: string | undefined) => void;
}) => {
  const { watch } = useFormContext<CreateCloudTask>();
  const branch = watch('branch');

  useEffect(() => {
    onBranchChange?.(branch);
  }, [branch, onBranchChange]);

  return <span data-testid="selected-branch">{branch}</span>;
};

describe('SelectBranch', () => {
  const mockedUseBranches = vi.mocked(useBranches);

  beforeEach(() => {
    vi.clearAllMocks();

    mockedUseBranches.mockReturnValue({
      data: branchNames,
      isPending: false,
      isLoading: false,
    } as ReturnType<typeof useBranches>);
  });

  it('caps rendered branch rows while still reporting the full match count', () => {
    render(<SelectBranchHarness />);

    const branchItems = screen.getAllByTestId('branch-item');

    expect(branchItems).toHaveLength(100);
    expect(branchItems[0]).toHaveTextContent('feature/000');
    expect(screen.queryByText('feature/149')).not.toBeInTheDocument();
    expect(
      screen.getByText('Showing 100 of 150 branches. Refine search for more.'),
    ).toBeInTheDocument();
  });

  it('keeps the selected branch visible when it is outside the render cap', () => {
    render(<SelectBranchHarness defaultValues={{ branch: 'feature/149' }} />);

    const branchItems = screen.getAllByTestId('branch-item');

    expect(branchItems).toHaveLength(100);
    expect(branchItems[0]).toHaveTextContent('feature/149');
    expect(screen.queryByText('feature/099')).not.toBeInTheDocument();
  });

  it('falls back to the first returned branch when the configured default branch no longer exists', async () => {
    const onBranchChange = vi.fn();

    const { rerender } = render(
      <SelectBranchHarness
        defaultBranch="feature/000"
        onBranchChange={onBranchChange}
        repositoryFullName="Roomote/Old"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('selected-branch')).toHaveTextContent(
        'feature/000',
      );
    });

    rerender(
      <SelectBranchHarness
        defaultBranch="feature/deleted"
        onBranchChange={onBranchChange}
        repositoryFullName="Roomote/example-app"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('selected-branch')).toHaveTextContent(
        'feature/000',
      );
    });

    expect(onBranchChange).not.toHaveBeenCalledWith('feature/deleted');
  });
});
