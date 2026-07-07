import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import type { GitDiffResponse } from '@roomote/types';

vi.mock('@/components/system', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./SidePanelHeader', () => ({
  SidePanelHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('./diff/DiffSkeleton', () => ({
  DiffSkeleton: () => <div>Loading diff</div>,
}));

vi.mock('./diff/EmptyState', () => ({
  EmptyState: () => <div>No files changed</div>,
}));

vi.mock('./diff/FileDiffBlock', () => ({
  FileDiffBlock: ({ file }: { file: { path: string } }) => (
    <div>{file.path}</div>
  ),
}));

vi.mock('./diff/FileNav', () => ({
  FileNav: ({
    repos,
  }: {
    repos: Array<{
      repoName: string;
    }>;
  }) => (
    <nav>
      {repos.map((repo) => (
        <div key={repo.repoName}>{repo.repoName}</div>
      ))}
    </nav>
  ),
}));

import { DiffSidePanel } from './DiffSidePanel';

describe('DiffSidePanel', () => {
  it('omits repositories that have no changed files', () => {
    const data: GitDiffResponse = {
      summary: {
        repoCount: 2,
        changedFileCount: 1,
        totalAdditions: 5,
        totalDeletions: 1,
        hasPendingChanges: true,
      },
      repos: [
        {
          repoName: 'Roomote/EmptyRepo',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        },
        {
          repoName: 'Roomote/example-app',
          files: [
            {
              path: 'apps/web/src/app/page.tsx',
              lines: [],
              additions: 5,
              deletions: 1,
              isNew: false,
              isDeleted: false,
            },
          ],
          totalAdditions: 5,
          totalDeletions: 1,
        },
      ],
    };

    render(
      <DiffSidePanel
        data={data}
        error={null}
        isLoading={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Roomote/EmptyRepo')).not.toBeInTheDocument();
    expect(screen.getByText('Roomote/example-app')).toBeInTheDocument();
    expect(screen.getByText('apps/web/src/app/page.tsx')).toBeInTheDocument();
  });
});
