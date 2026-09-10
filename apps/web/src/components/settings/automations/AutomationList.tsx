'use client';

import type { ComponentType, ReactNode } from 'react';
import { createContext, useContext } from 'react';

import {
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Search,
} from '@/components/system';

export type AutomationListFilter = 'all' | 'custom' | 'built-in';

const AutomationListOrderContext = createContext<ReadonlyMap<string, number>>(
  new Map(),
);

export function useAutomationListOrder(name: string) {
  return useContext(AutomationListOrderContext).get(name);
}

export function AutomationListOrderProvider({
  names,
  children,
}: {
  names: readonly string[];
  children: ReactNode;
}) {
  const order = new Map(
    names
      .toSorted((left, right) => left.localeCompare(right))
      .map((name, index) => [name, index]),
  );

  return (
    <AutomationListOrderContext.Provider value={order}>
      {children}
    </AutomationListOrderContext.Provider>
  );
}

export function AutomationListToolbar({
  filter,
  search,
  leading,
  action,
  showBuiltInFilter = true,
  onFilterChange,
  onSearchChange,
}: {
  filter: AutomationListFilter;
  search: string;
  leading?: ReactNode;
  action?: ReactNode;
  showBuiltInFilter?: boolean;
  onFilterChange: (filter: AutomationListFilter) => void;
  onSearchChange: (search: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      {leading}
      <RadioGroup
        value={filter}
        onValueChange={(value) => onFilterChange(value as AutomationListFilter)}
        aria-label="Automation type"
        className="flex items-center gap-4 md:ml-auto"
      >
        {(
          [
            ['all', 'All'],
            ['custom', 'Custom'],
            ['built-in', 'Built-in'],
          ] as const
        )
          .filter(([value]) => showBuiltInFilter || value !== 'built-in')
          .map(([value, label]) => (
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
      <div className="relative">
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
      className="hidden grid-cols-[2rem_1rem_minmax(0,4fr)_minmax(0,6fr)_7rem] gap-4 border-b border-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
    >
      <span role="columnheader" className="sr-only">
        Enabled
      </span>
      <span role="columnheader" className="sr-only">
        Icon
      </span>
      <span role="columnheader" className="col-start-3">
        Name
      </span>
      <span role="columnheader" className="col-start-4">
        Description
      </span>
      <span role="columnheader" className="sr-only">
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
  order: explicitOrder,
}: {
  icon: ComponentType<{ className?: string }>;
  name: string;
  summary: ReactNode;
  description: ReactNode;
  enabledControl: ReactNode;
  actions?: ReactNode;
  order?: number;
}) {
  const contextualOrder = useAutomationListOrder(name);
  const order = explicitOrder ?? contextualOrder;

  return (
    <div
      role="row"
      aria-rowindex={order === undefined ? undefined : order + 2}
      style={order === undefined ? undefined : { order }}
      className="grid grid-cols-[2rem_1rem_minmax(0,1fr)_auto] gap-x-2 gap-y-1 px-2 py-1.5 md:grid-cols-[2rem_1rem_minmax(0,4fr)_minmax(0,6fr)_7rem] md:items-center md:gap-4 md:px-4 md:py-3"
    >
      <div
        role="cell"
        className="col-start-1 row-span-2 row-start-1 flex items-start pt-0.5 md:row-span-1 md:items-center md:pt-0"
      >
        {enabledControl}
      </div>
      <div role="cell" className="col-start-2 row-start-1 pt-0.5 md:pt-0">
        <Icon className="size-4 shrink-0" />
      </div>
      <div role="cell" className="col-start-3 row-start-1 min-w-0">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <div className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
            {summary}
          </div>
        </div>
      </div>
      <div
        role="cell"
        className="col-span-2 col-start-3 row-start-2 min-w-0 whitespace-normal text-sm text-muted-foreground/80 md:col-span-1 md:col-start-4 md:row-start-1"
      >
        {description}
      </div>
      <div
        role="cell"
        className="col-start-4 row-start-1 flex shrink-0 items-center justify-end gap-1 md:col-start-5"
      >
        {actions}
      </div>
    </div>
  );
}
