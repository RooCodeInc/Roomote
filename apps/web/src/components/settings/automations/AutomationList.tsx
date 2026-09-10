'use client';

import type { ComponentType, ReactNode } from 'react';

import {
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Search,
} from '@/components/system';

export type AutomationListFilter = 'all' | 'custom' | 'built-in';

export function AutomationListToolbar({
  filter,
  search,
  action,
  onFilterChange,
  onSearchChange,
}: {
  filter: AutomationListFilter;
  search: string;
  action?: ReactNode;
  onFilterChange: (filter: AutomationListFilter) => void;
  onSearchChange: (search: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <RadioGroup
        value={filter}
        onValueChange={(value) => onFilterChange(value as AutomationListFilter)}
        aria-label="Automation type"
        className="flex items-center gap-4"
      >
        {(
          [
            ['all', 'All'],
            ['custom', 'Custom'],
            ['built-in', 'Built-in'],
          ] as const
        ).map(([value, label]) => (
          <div key={value} className="flex items-center gap-2">
            <RadioGroupItem value={value} id={`automation-filter-${value}`} />
            <Label
              htmlFor={`automation-filter-${value}`}
              className="cursor-pointer text-sm font-normal"
            >
              {label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <div className="relative sm:ml-auto">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search automations"
          aria-label="Search automations"
          className="h-8 w-full pl-8 text-sm sm:w-56"
        />
      </div>
      {action}
    </div>
  );
}

export function AutomationListHeader() {
  return (
    <div
      role="row"
      className="hidden grid-cols-[auto_minmax(13rem,1fr)_minmax(16rem,2fr)_auto] gap-4 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
    >
      <span role="columnheader" className="w-9">
        Active
      </span>
      <span role="columnheader">Name</span>
      <span role="columnheader">Description</span>
      <span role="columnheader" className="w-32 text-right">
        Actions
      </span>
    </div>
  );
}

export function AutomationListRow({
  icon: Icon,
  name,
  summary,
  description,
  enabledControl,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  name: string;
  summary: ReactNode;
  description: ReactNode;
  enabledControl: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div
      role="row"
      className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[auto_minmax(13rem,1fr)_minmax(16rem,2fr)_auto] md:items-center md:gap-4"
    >
      <div
        role="cell"
        className="col-start-1 row-start-2 flex w-9 items-center md:row-start-1"
      >
        {enabledControl}
      </div>
      <div
        role="cell"
        className="col-span-2 row-start-1 min-w-0 space-y-1 md:col-span-1 md:col-start-2"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span className="rounded-md border border-border/70 bg-muted/30 p-1.5">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 truncate">{name}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          {summary}
        </div>
      </div>
      <div
        role="cell"
        className="col-span-2 min-w-0 whitespace-normal text-sm text-muted-foreground md:col-span-1 md:col-start-3"
      >
        {description}
      </div>
      <div
        role="cell"
        className="col-start-2 row-start-2 flex min-w-32 shrink-0 items-center justify-end gap-1 md:col-start-4 md:row-start-1"
      >
        {actions}
      </div>
    </div>
  );
}
