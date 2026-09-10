'use client';

import type { ComponentType, ReactNode } from 'react';

import {
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Search,
} from '@/components/system';

export type SkillListFilter = 'all' | 'shared' | 'environment';

export function SkillListToolbar({
  filter,
  search,
  actions,
  showEnvironmentFilter,
  onFilterChange,
  onSearchChange,
}: {
  filter: SkillListFilter;
  search: string;
  actions: ReactNode;
  showEnvironmentFilter: boolean;
  onFilterChange: (filter: SkillListFilter) => void;
  onSearchChange: (search: string) => void;
}) {
  const filters = [
    ['all', 'All'],
    ['shared', 'Shared'],
    ['environment', 'Env-Specific'],
  ] as const;

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <RadioGroup
        value={filter}
        onValueChange={(value) => onFilterChange(value as SkillListFilter)}
        aria-label="Skill availability"
        className="flex flex-wrap items-center gap-4 md:ml-auto"
      >
        {filters
          .filter(([value]) => showEnvironmentFilter || value !== 'environment')
          .map(([value, label]) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem value={value} id={`skill-filter-${value}`} />
              <Label
                htmlFor={`skill-filter-${value}`}
                className="cursor-pointer text-sm font-normal"
              >
                {label}
              </Label>
            </div>
          ))}
      </RadioGroup>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search skills"
          aria-label="Search skills"
          className="h-8 w-full pl-8 text-sm sm:w-56"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function SkillListHeader() {
  return (
    <div
      role="row"
      className="hidden grid-cols-[auto_minmax(0,4fr)_minmax(0,5fr)_minmax(12rem,3fr)_auto] gap-4 border-b border-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
    >
      <span aria-hidden className="w-4" />
      <span role="columnheader" className="col-start-2">
        Name
      </span>
      <span role="columnheader" className="col-start-3">
        Description
      </span>
      <span role="columnheader" className="col-start-4">
        Availability
      </span>
    </div>
  );
}

export function SkillListRow({
  icon: Icon,
  name,
  summary,
  description,
  availability,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  name: ReactNode;
  summary?: ReactNode;
  description: ReactNode;
  availability: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role="row"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 px-2 py-1.5 md:grid-cols-[auto_minmax(0,4fr)_minmax(0,5fr)_minmax(12rem,3fr)_auto] md:items-center md:gap-4 md:px-4 md:py-3"
    >
      <div
        role="cell"
        className="col-start-1 row-span-3 row-start-1 flex w-4 items-start pt-0.5 md:row-span-1 md:items-center md:pt-0"
      >
        <Icon className="size-4 shrink-0" />
      </div>
      <div role="cell" className="col-start-2 row-start-1 min-w-0 space-y-1">
        <div className="truncate text-sm font-semibold">{name}</div>
        {summary ? (
          <div className="text-xs text-muted-foreground">{summary}</div>
        ) : null}
      </div>
      <div
        role="cell"
        className="col-span-2 col-start-2 row-start-2 min-w-0 text-xs text-muted-foreground/80 md:col-span-1 md:col-start-3 md:row-start-1"
      >
        {description}
      </div>
      <div
        role="cell"
        className="col-span-2 col-start-2 row-start-3 min-w-0 text-xs text-muted-foreground md:col-span-1 md:col-start-4 md:row-start-1"
      >
        {availability}
      </div>
      <div
        role="cell"
        className="col-start-3 row-start-1 flex shrink-0 items-center justify-end gap-1 md:col-start-5"
      >
        {actions}
      </div>
    </div>
  );
}
