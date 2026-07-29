'use client';

import { useMemo } from 'react';

import { Checkbox, ScrollArea } from '@/components/system';
import { PackagePlus } from 'lucide-react';

type RepositorySummary = {
  id: string;
  fullName: string;
};

export function EnvironmentRepositorySelector({
  repositories,
  selectedRepositoryIds,
  onToggleRepository,
  onCreateRepository,
  inputPrefix = 'environment-repository',
  heightClassName = 'max-h-[11.5rem] md:h-[18.75rem]',
}: {
  repositories: RepositorySummary[];
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onCreateRepository?: () => void;
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
        {onCreateRepository ? (
          <p className="border-b border-dotted pb-1">
            <span
              className="w-full justify-start flex items-center gap-2 cursor-pointer hover:text-accent-foreground py-1"
              onClick={onCreateRepository}
            >
              <PackagePlus className="size-4 mx-0.5" />
              Create a new repository
            </span>
          </p>
        ) : null}
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
