import { render, screen } from '@testing-library/react';

import { AnalyticsDetailsDialog } from './AnalyticsDetailsDialog';

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const BASE_PROPS = {
  open: true,
  bucketLabel: 'Mar 10',
  seriesLabel: 'App',
  isLoading: false,
  isError: false,
  onDownload: vi.fn(),
  isDownloadDisabled: false,
  onOpenChange: vi.fn(),
};

describe('AnalyticsDetailsDialog', () => {
  it('truncates long task titles for tasks in the UI', () => {
    const longTaskTitle = 'A'.repeat(120);
    const expectedTruncated = `${longTaskTitle.slice(0, 89)}…`;

    render(
      <AnalyticsDetailsDialog
        {...BASE_PROPS}
        object="tasks"
        data={{
          object: 'tasks',
          bucketKey: '2026-03-10',
          seriesKey: 'app',
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'user', label: 'User' },
            { key: 'project', label: 'Environment' },
            { key: 'source', label: 'Source' },
            { key: 'taskTitle', label: 'Task Title' },
            { key: 'task', label: 'Task Link' },
          ],
          rows: [
            {
              id: 'row-1',
              values: {
                date: 'Mar 10',
                user: 'User',
                project: 'App',
                source: 'Web',
                taskTitle: longTaskTitle,
                task: 'View task',
              },
              links: {
                task: '/task/abc123',
              },
            },
          ],
          total: 1,
        }}
      />,
    );

    expect(screen.getByTitle(longTaskTitle)).toHaveTextContent(
      expectedTruncated,
    );
    expect(screen.queryByText(longTaskTitle)).not.toBeInTheDocument();
  });

  it('does not truncate long values for non-task objects', () => {
    const longPullRequestTitle = 'B'.repeat(120);

    render(
      <AnalyticsDetailsDialog
        {...BASE_PROPS}
        object="pullRequests"
        data={{
          object: 'pullRequests',
          bucketKey: '2026-03-10',
          seriesKey: 'reviewer',
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'user', label: 'User' },
            { key: 'author', label: 'Author' },
            { key: 'repo', label: 'Repo' },
            { key: 'pr', label: 'PR' },
            { key: 'status', label: 'Status' },
            { key: 'createdBy', label: 'Created By' },
            { key: 'task', label: 'Task Link' },
          ],
          rows: [
            {
              id: 'row-1',
              values: {
                date: 'Mar 10',
                user: 'Owner',
                author: 'Reviewer',
                repo: 'org/repo',
                pr: longPullRequestTitle,
                status: 'Open',
                createdBy: 'Human',
                task: 'View task',
              },
              links: {
                task: '/task/abc123',
              },
            },
          ],
          total: 1,
        }}
      />,
    );

    expect(screen.getByText(longPullRequestTitle)).toBeInTheDocument();
  });
});
