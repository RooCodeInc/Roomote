import React from 'react';
import { render } from '@testing-library/react';
import { cloudTaskTypes } from '@roomote/types';

const {
  useUsersForFilterMock,
  useRepositoriesForFilterMock,
  useModelsForFilterMock,
  usePullRequestsForFilterMock,
} = vi.hoisted(() => ({
  useUsersForFilterMock: vi.fn(() => ({ data: [] })),
  useRepositoriesForFilterMock: vi.fn(() => ({ data: [] })),
  useModelsForFilterMock: vi.fn(() => ({ data: [] })),
  usePullRequestsForFilterMock: vi.fn(() => ({ data: [] })),
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
  Calendar: Icon,
  ChevronDown: Icon,
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

  it('renders all cloud task types when the task-type filter is visible', () => {
    const { getByText } = render(
      <TaskFilters
        {...baseProps}
        taskTypes={[]}
        showTaskType={true}
        onTaskTypesChange={vi.fn()}
      />,
    );

    for (const taskType of cloudTaskTypes) {
      expect(getByText(taskType)).toBeInTheDocument();
    }
  });
});
