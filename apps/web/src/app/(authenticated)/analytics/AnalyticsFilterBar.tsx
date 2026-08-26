import { useCallback, useMemo, useState } from 'react';

import {
  type AnalyticsDimension,
  type AnalyticsFilterOption,
  type AnalyticsFilters,
  type AnalyticsObject,
  ANALYTICS_DIMENSION_LABELS,
  ANALYTICS_OBJECT_CONFIG,
} from '@/types';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Funnel,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ChevronsUpDown,
} from '@/components/system';

import { ANALYTICS_DIMENSION_ICONS } from './AnalyticsDimensionIcons';

const ANALYTICS_DIMENSION_PLURAL_LABELS: Record<AnalyticsDimension, string> = {
  user: 'Users',
  project: 'Environments',
  source: 'Sources',
  status: 'Statuses',
  repo: 'Repos',
  author: 'Authors',
  taskType: 'Task Types',
  provider: 'Providers',
  model: 'Models',
  ownerKind: 'Owner kinds',
  hasExecution: 'Execution states',
};

type AnalyticsFilterBarProps = {
  object: AnalyticsObject;
  filters: AnalyticsFilters;
  filterOptions: Partial<Record<AnalyticsDimension, AnalyticsFilterOption[]>>;
  onFilterChange: (dimension: AnalyticsDimension, value: string[]) => void;
  onResetFilters: () => void;
};

type AnalyticsFilterControlProps = {
  dimension: AnalyticsDimension;
  value: string[] | undefined;
  options: AnalyticsFilterOption[];
  onChange: (value: string[]) => void;
  presentation?: 'toolbar' | 'drawer';
};

function formatAnalyticsFilterValue(
  dimension: AnalyticsDimension,
  value: string,
) {
  if (dimension === 'project' && value.includes('/')) {
    return value.split('/').at(-1) ?? value;
  }

  return value;
}

function getAnalyticsFilterLabel(
  dimension: AnalyticsDimension,
  values: string[],
) {
  if (values.length === 0) {
    return ANALYTICS_DIMENSION_LABELS[dimension];
  }

  if (values.length === 1) {
    return formatAnalyticsFilterValue(dimension, values[0]!);
  }

  return `${values.length} ${ANALYTICS_DIMENSION_PLURAL_LABELS[dimension]}`;
}

function splitProjectOptions(options: AnalyticsFilterOption[]) {
  return {
    projects: options.filter((option) => !option.value.includes('/')),
    repositories: options.filter((option) => option.value.includes('/')),
  };
}

export function normalizeSelectedAnalyticsFilterValues(
  selectedValues: string[] | undefined,
  options: AnalyticsFilterOption[],
) {
  const selected = selectedValues ?? [];
  const normalizedValues = selected.flatMap((selectedValue) => {
    const exactValueMatch = options.find(
      (option) => option.value === selectedValue,
    );

    if (exactValueMatch) {
      return [exactValueMatch.value];
    }

    const matchingLabels = options
      .filter((option) => option.label === selectedValue)
      .map((option) => option.value);

    return matchingLabels.length > 0 ? matchingLabels : [selectedValue];
  });

  return [...new Set(normalizedValues)];
}

function AnalyticsFilterControl({
  dimension,
  value,
  options,
  onChange,
  presentation = 'toolbar',
}: AnalyticsFilterControlProps) {
  const Icon = ANALYTICS_DIMENSION_ICONS[dimension] ?? Funnel;
  const selectedValues = normalizeSelectedAnalyticsFilterValues(value, options);
  const selectedLabels = selectedValues.map(
    (selectedValue) =>
      options.find((option) => option.value === selectedValue)?.label ||
      selectedValue,
  );
  const activeLabel = getAnalyticsFilterLabel(dimension, selectedLabels);
  const activeFilterStyle = 'text-accent-foreground font-medium';
  const defaultFilterStyle = 'text-foreground hover:text-accent-foreground';

  const toggleValue = (nextValue: string) => {
    onChange(
      selectedValues.includes(nextValue)
        ? selectedValues.filter((existingValue) => existingValue !== nextValue)
        : [...selectedValues, nextValue],
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={presentation === 'drawer' ? 'outline' : 'ghost'}
          size="sm"
          className={cn(
            selectedValues.length > 0 ? activeFilterStyle : defaultFilterStyle,
            selectedValues.length === 0 && 'font-normal',
            presentation === 'drawer'
              ? 'w-full justify-between gap-2 rounded-lg border-border/60 bg-card px-3'
              : 'gap-0 px-1!',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="size-4 shrink-0" />
            <span className="truncate align-middle">{activeLabel}</span>
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 align-middle',
              presentation === 'toolbar' && 'ml-1 hidden lg:inline-block',
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="z-system max-w-64 md:z-popover">
        <DropdownMenuCheckboxItem
          checked={selectedValues.length === 0}
          className="cursor-pointer"
          onSelect={(event) => {
            event.preventDefault();
            onChange([]);
          }}
        >
          Any {ANALYTICS_DIMENSION_LABELS[dimension]}
        </DropdownMenuCheckboxItem>
        {dimension === 'project' ? (
          (() => {
            const { projects, repositories } = splitProjectOptions(options);

            return (
              <>
                {(projects.length > 0 || repositories.length > 0) && (
                  <DropdownMenuSeparator />
                )}
                {projects.length > 0 && (
                  <>
                    <DropdownMenuLabel>Environments</DropdownMenuLabel>
                    {projects.map((option) => (
                      <DropdownMenuCheckboxItem
                        key={option.value}
                        checked={selectedValues.includes(option.value)}
                        className="cursor-pointer"
                        onSelect={(event) => {
                          event.preventDefault();
                          toggleValue(option.value);
                        }}
                      >
                        <span className="truncate">{option.label}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </>
                )}
                {projects.length > 0 && repositories.length > 0 && (
                  <DropdownMenuSeparator />
                )}
                {repositories.length > 0 && (
                  <>
                    <DropdownMenuLabel>Repositories</DropdownMenuLabel>
                    {repositories.map((option) => (
                      <DropdownMenuCheckboxItem
                        key={option.value}
                        checked={selectedValues.includes(option.value)}
                        className="cursor-pointer"
                        onSelect={(event) => {
                          event.preventDefault();
                          toggleValue(option.value);
                        }}
                      >
                        <span className="truncate">{option.label}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </>
                )}
              </>
            );
          })()
        ) : (
          <>
            {options.length > 0 && <DropdownMenuSeparator />}
            {options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={selectedValues.includes(option.value)}
                className="cursor-pointer"
                onSelect={(event) => {
                  event.preventDefault();
                  toggleValue(option.value);
                }}
              >
                <span className="truncate">{option.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AnalyticsFilterBar({
  object,
  filters,
  filterOptions,
  onFilterChange,
  onResetFilters,
}: AnalyticsFilterBarProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const filterDimensions = ANALYTICS_OBJECT_CONFIG[object].filterDimensions;
  const activeFilterCount = filterDimensions.reduce(
    (count, dimension) =>
      count + ((filters[dimension]?.length ?? 0) > 0 ? 1 : 0),
    0,
  );

  const renderControls = useCallback(
    (presentation: AnalyticsFilterControlProps['presentation']) =>
      filterDimensions.map((dimension) => (
        <AnalyticsFilterControl
          key={dimension}
          dimension={dimension}
          value={filters[dimension]}
          options={filterOptions[dimension] ?? []}
          presentation={presentation}
          onChange={(value) => onFilterChange(dimension, value)}
        />
      )),
    [filterDimensions, filterOptions, filters, onFilterChange],
  );

  const toolbarControls = useMemo(
    () => renderControls('toolbar'),
    [renderControls],
  );
  const drawerControls = useMemo(
    () => renderControls('drawer'),
    [renderControls],
  );

  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 md:flex py-2 m-0">
        <span className="text-sm text-muted-foreground">Filter by</span>
        {toolbarControls}
      </div>

      <Button
        type="button"
        variant="outline"
        className="justify-between gap-2 text-sm rounded-lg bg-card border-border md:hidden font-light"
        onClick={() => setIsMobileOpen(true)}
      >
        <Funnel className="size-4" />
        <span>Filters ({activeFilterCount})</span>
        <ChevronsUpDown className="size-3 shrink-0" />
      </Button>

      <Dialog open={isMobileOpen} onOpenChange={setIsMobileOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
            <DialogDescription className="sr-only">
              Adjust analytics filters.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="grid gap-2 sm:grid-cols-2">{drawerControls}</div>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={onResetFilters}
            >
              Reset Filters
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
