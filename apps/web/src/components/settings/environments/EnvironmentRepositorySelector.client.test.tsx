import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { EnvironmentRepositorySelector } from './EnvironmentRepositorySelector';

const repositories = [
  { id: 'repo-web', fullName: 'Acme/web' },
  { id: 'repo-api', fullName: 'acme/api' },
  { id: 'repo-roomote', fullName: 'RoomoteInc/Roomote' },
];

function SelectorHarness({
  initialSelection = [],
  onCreateRepository,
}: {
  initialSelection?: string[];
  onCreateRepository?: () => void;
}) {
  const [selectedRepositoryIds, setSelectedRepositoryIds] =
    useState(initialSelection);

  return (
    <EnvironmentRepositorySelector
      repositories={repositories}
      selectedRepositoryIds={selectedRepositoryIds}
      onToggleRepository={(repositoryId) =>
        setSelectedRepositoryIds((currentSelection) =>
          currentSelection.includes(repositoryId)
            ? currentSelection.filter((id) => id !== repositoryId)
            : [...currentSelection, repositoryId],
        )
      }
      onCreateRepository={onCreateRepository}
      inputPrefix="test-repository"
    />
  );
}

describe('EnvironmentRepositorySelector', () => {
  it('filters repository full names case-insensitively and restores sorted results', async () => {
    render(<SelectorHarness />);

    expect(
      screen.getAllByRole('checkbox').map((checkbox) => checkbox.id),
    ).toEqual([
      'test-repository-repo-api',
      'test-repository-repo-web',
      'test-repository-repo-roomote',
    ]);

    const search = screen.getByRole('searchbox', {
      name: 'Search repositories',
    });
    fireEvent.change(search, { target: { value: 'ROOMOTE' } });

    await waitFor(() => {
      expect(screen.getByText('RoomoteInc/Roomote')).toBeInTheDocument();
      expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    });
  });

  it('preserves selected repositories while they are filtered out', async () => {
    render(<SelectorHarness initialSelection={['repo-web']} />);

    const search = screen.getByRole('searchbox', {
      name: 'Search repositories',
    });
    fireEvent.change(search, { target: { value: 'api' } });

    await waitFor(() => {
      expect(screen.queryByText('Acme/web')).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Acme/web')).toBeChecked();
    });
  });

  it('keeps repository creation available when no repositories match', async () => {
    const onCreateRepository = vi.fn();
    render(<SelectorHarness onCreateRepository={onCreateRepository} />);

    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search repositories' }),
      { target: { value: 'missing' } },
    );

    await waitFor(() => {
      expect(screen.getByText('No repositories found.')).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create a new repository' }),
    );
    expect(onCreateRepository).toHaveBeenCalledOnce();
  });

  it('omits search for an empty list while retaining repository creation', () => {
    const onCreateRepository = vi.fn();

    render(
      <EnvironmentRepositorySelector
        repositories={[]}
        selectedRepositoryIds={[]}
        onToggleRepository={vi.fn()}
        onCreateRepository={onCreateRepository}
      />,
    );

    expect(
      screen.queryByRole('searchbox', { name: 'Search repositories' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create a new repository' }),
    ).toBeInTheDocument();
  });
});
