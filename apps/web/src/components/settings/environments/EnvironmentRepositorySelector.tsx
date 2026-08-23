'use client';

import { useDeferredValue, useMemo, useState } from 'react';

import {
  Checkbox,
  Input,
  PackagePlus,
  ScrollArea,
  Search,
} from '@/components/system';

type RepositorySummary = {
  id: string;
  fullName: string;
};

export function EnvironmentRepositorySelector({
  repositories,
  selectedRepositoryIds,
  onToggleRepository,
  onCreateRepository,
  showSearch = true,
  inputPrefix = 'environment-repository',
  heightClassName = 'max-h-[11.5rem] md:h-[18.75rem]',
}: {
  repositories: RepositorySummary[];
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onCreateRepository?: () => void;
  showSearch?: boolean;
  inputPrefix?: string;
  heightClassName?: string;
}) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const sortedRepositories = useMemo(
    () =>
      [...repositories].sort((left, right) =>
        left.fullName.localeCompare(right.fullName),
      ),
    [repositories],
  );
  const filteredRepositories = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    if (!query) {
      return sortedRepositories;
    }

    return sortedRepositories.filter((repository) =>
      repository.fullName.toLowerCase().includes(query),
    );
  }, [deferredSearch, sortedRepositories]);

  return (
    <ScrollArea className={`overflow-auto ${heightClassName}`}>
      <div className="space-y-1">
        {showSearch && repositories.length > 0 ? (
          <div className="sticky top-0 z-10 bg-card pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search repositories"
                placeholder="Search repositories…"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                className="pl-9"
              />
            </div>
          </div>
        ) : null}
        {onCreateRepository ? (
          <p className="border-b border-dotted pb-1">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 py-1 text-left hover:text-accent-foreground"
              onClick={onCreateRepository}
            >
              <PackagePlus className="size-4 mx-0.5" />
              Create a new repository
            </button>
          </p>
        ) : null}
        {filteredRepositories.length === 0 && deferredSearch.trim() ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No repositories found.
          </p>
        ) : (
          filteredRepositories.map((repository) => (
            <label
              key={repository.id}
              className="flex cursor-pointer items-start gap-3 rounded-md py-1 text-foreground transition-colors hover:bg-muted/30"
              htmlFor={`${inputPrefix}-${repository.id}`}
            >
              <Checkbox
                id={`${inputPrefix}-${repository.id}`}
                checked={selectedRepositoryIds.includes(repository.id)}
                onCheckedChange={() => onToggleRepository(repository.id)}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">{repository.fullName}</div>
            </label>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
