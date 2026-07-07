'use client';

import { useMemo } from 'react';

import { Checkbox, ScrollArea } from '@/components/system';

type RepositorySummary = {
  id: string;
  fullName: string;
};

export function EnvironmentRepositorySelector({
  repositories,
  selectedRepositoryIds,
  onToggleRepository,
  inputPrefix = 'environment-repository',
  heightClassName = 'max-h-[11.5rem] md:h-[18.75rem]',
}: {
  repositories: RepositorySummary[];
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  inputPrefix?: string;
  heightClassName?: string;
}) {
  const sortedRepositories = useMemo(
    () =>
      [...repositories].sort((left, right) =>
        left.fullName.localeCompare(right.fullName),
      ),
    [repositories],
  );

  return (
    <ScrollArea className={`overflow-auto ${heightClassName}`}>
      <div className="space-y-1">
        {sortedRepositories.map((repository) => (
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
        ))}
      </div>
    </ScrollArea>
  );
}
