import { fireEvent, render, screen } from '@testing-library/react';

import { FileNav } from './FileNav';

describe('FileNav', () => {
  it('shows the full file path on hover and keeps its own scroll container', () => {
    const onSelect = vi.fn();
    const filePath = 'apps/web/src/components/inspect/FileNav.tsx';

    render(
      <FileNav
        repos={[
          {
            repoName: 'Roomote/example-app',
            files: [
              {
                path: filePath,
                lines: [],
                additions: 12,
                deletions: 3,
                isNew: false,
                isDeleted: false,
              },
            ],
            totalAdditions: 12,
            totalDeletions: 3,
          },
        ]}
        onSelect={onSelect}
      />,
    );

    const nav = screen.getByRole('navigation');
    const fileButton = screen.getByTitle(filePath);

    expect(nav).toHaveClass('h-full', 'overflow-y-auto');
    expect(fileButton).toHaveAttribute('title', filePath);

    fireEvent.click(fileButton);

    expect(onSelect).toHaveBeenCalledWith('Roomote/example-app', filePath);
  });
});
