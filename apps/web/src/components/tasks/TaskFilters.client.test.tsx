import React from 'react';
import { render } from '@testing-library/react';
import { TASK_WORKFLOWS } from '@roomote/types';

import { formatAutomationLabel } from '@/lib/task-creator-filter';

const {
  useUsersForFilterMock,
  useRepositoriesForFilterMock,
  useModelsForFilterMock,
  usePullRequestsForFilterMock,
} = vi.hoisted(() => ({
  useUsersForFilterMock: vi.fn(() => ({
    data: [] as Array<{ value: string; label: string; subLabel?: string }>,
  })),
  useRepositoriesForFilterMock: vi.fn(() => ({
    data: [] as Array<{ value: string; label: string; subLabel?: string }>,
  })),
  useModelsForFilterMock: vi.fn(() => ({
    data: [] as Array<{ value: string; label: string; subLabel?: string }>,
  })),
  usePullRequestsForFilterMock: vi.fn(() => ({
    data: [] as Array<{ value: string; label: string; subLabel?: string }>,
  })),
}));

vi.mock('@/hooks/filters', () => ({
  useUsersForFilter: useUsersForFilterMock,
  useRepositoriesForFilter: useRepositoriesForFilterMock,
  useEnvironmentsForFilter: () => ({ data: [] }),
  useModelsForFilter: useModelsForFilterMock,
  usePullRequestsForFilter: usePullRequestsForFilterMock,
}));

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('@/components/system', () => ({
  Bug: Icon,
  Calendar: Icon,
  ChevronDown: Icon,
  FileText: Icon,
  VectorSquare: Icon,
  Brain: Icon,
  GitPullRequest: Icon,
  Shapes: Icon,
  Search: Icon,
  CircleUserRound: Icon,
  X: Icon,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuCheckboxItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

import { TaskFilters } from './TaskFilters';

describe('TaskFilters', () => {
  const baseProps = {
    userId: null,
    defaultUserId: 'user-1',
    repositoryName: null,
    pullRequest: null,
    model: null,
    timePeriod: 'all' as const,
    onUserChange: vi.fn(),
    onRepositoryChange: vi.fn(),
    onPullRequestChange: vi.fn(),
    onModelChange: vi.fn(),
    onTimePeriodChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useUsersForFilterMock.mockReturnValue({ data: [] });
    useRepositoriesForFilterMock.mockReturnValue({ data: [] });
    useModelsForFilterMock.mockReturnValue({ data: [] });
    usePullRequestsForFilterMock.mockReturnValue({ data: [] });
  });

  it('forwards the active category to the filter hooks', () => {
    render(<TaskFilters {...baseProps} category="pr-reviews" />);

    expect(useUsersForFilterMock).toHaveBeenCalledWith({
      repositoryName: null,
      category: 'pr-reviews',
      timePeriod: 'all',
    });
    expect(useRepositoriesForFilterMock).toHaveBeenCalledWith({
      userId: null,
      category: 'pr-reviews',
      timePeriod: 'all',
    });
    expect(usePullRequestsForFilterMock).toHaveBeenCalledWith({
      userId: null,
      category: 'pr-reviews',
      repositoryName: null,
      timePeriod: 'all',
      search: '',
    });
  });

  it('groups the user filter into Users and Automations sections', () => {
    useUsersForFilterMock.mockReturnValue({
      data: [
        { value: 'user-2', label: 'Alex' },
        { value: 'automation:pr_review', label: 'PR Review' },
        { value: 'user-1', label: 'You Name' },
        {
          value: 'automation:conflict_resolver',
          label: 'Conflict Resolver',
        },
      ],
    });

    const { getByText, queryByText } = render(<TaskFilters {...baseProps} />);

    expect(getByText('Any User')).toBeInTheDocument();
    expect(getByText('Users')).toBeInTheDocument();
    expect(getByText('Automations')).toBeInTheDocument();
    expect(getByText('Alex')).toBeInTheDocument();
    expect(getByText('PR Review')).toBeInTheDocument();
    expect(getByText('Conflict Resolver')).toBeInTheDocument();
    expect(queryByText('Automation')).not.toBeInTheDocument();
  });

  it('renders all task workflows when the task-type filter is visible', () => {
    const { getByText } = render(
      <TaskFilters
        {...baseProps}
        taskTypes={[]}
        showTaskType={true}
        onTaskTypesChange={vi.fn()}
      />,
    );

    for (const workflow of TASK_WORKFLOWS) {
      expect(getByText(formatAutomationLabel(workflow))).toBeInTheDocument();
    }
  });
});
