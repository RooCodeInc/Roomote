'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { getSessionStatusLabel, SESSION_STATUSES } from '@roomote/types';

import type { TimePeriodFilter } from '@/types';
import { cn } from '@/lib/utils';
import { getSessionSurfaceLabel } from '@/components/sessions/session-surfaces';
import { TaskFilters } from '@/components/tasks';
import {
  Activity,
  Button,
  ChevronDown,
  Columns3,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  List,
  MessagesSquare,
  Search,
  Share2,
  SlidersHorizontal,
} from '@/components/system';

const ADVANCED_FILTERS_STORAGE_KEY =
  'roomote-sessions-advanced-filters-visible';
const SESSIONS_VIEW_STORAGE_KEY = 'roomote-sessions-view';

const activeFilterStyle =
  'text-accent-foreground font-medium border-b-2 border-accent-foreground focus-visible:border-accent-foreground rounded-none';
const defaultFilterStyle = 'text-muted-foreground hover:text-accent-foreground';

const scopeOptions = [
  { value: 'all', label: 'All sessions' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'automations', label: 'Automations' },
];

type FilterOption = { value: string; label: string };

function SessionFilterDropdown({
  ariaLabel,
  icon,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  const active = value !== 'all';
  const label = options.find((option) => option.value === value)?.label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={ariaLabel}
          className={cn(
            active ? activeFilterStyle : defaultFilterStyle,
            !active && 'font-normal',
            'px-1! gap-0',
          )}
        >
          {icon}
          <span className="hidden max-w-48 truncate align-middle lg:mr-0 lg:inline-block">
            {label ?? options[0]?.label}
          </span>
          <ChevronDown className="ml-1 hidden size-3 shrink-0 align-middle lg:inline-block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value === option.value}
            onClick={() => onChange(option.value)}
            className="cursor-pointer"
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function readStoredBoolean(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeStoredPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage failures.
  }
}

export function SessionsFilters({
  userId,
  timePeriod,
  scope = 'all',
  status = 'all',
  view = 'list',
  query = '',
  repository = null,
  pullRequest = null,
  model = null,
  source = 'all',
  sourceOptions,
}: {
  userId: string | null;
  timePeriod: TimePeriodFilter;
  scope?: string;
  status?: string;
  view?: string;
  query?: string;
  repository?: string | null;
  pullRequest?: string | null;
  model?: string | null;
  source?: string;
  sourceOptions: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showSearch, setShowSearch] = useState(Boolean(query));

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      params.delete('before');
      const nextQuery = params.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [router, pathname, searchParams],
  );

  useEffect(() => {
    setShowAdvancedFilters(readStoredBoolean(ADVANCED_FILTERS_STORAGE_KEY));
  }, []);

  useEffect(() => {
    if (query) setShowSearch(true);
  }, [query]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    if (searchParams.has('view')) return;

    try {
      if (window.localStorage.getItem(SESSIONS_VIEW_STORAGE_KEY) === 'board') {
        updateParams((params) => params.set('view', 'board'));
      }
    } catch {
      // Ignore localStorage failures.
    }
  }, [searchParams, updateParams]);

  const updateNullableParam = (name: string, value: string | null) =>
    updateParams((params) => {
      if (value) params.set(name, value);
      else params.delete(name);
    });

  const sessionStatusOptions = [
    { value: 'all', label: 'All statuses' },
    ...SESSION_STATUSES.map((value) => ({
      value,
      label: getSessionStatusLabel(value),
    })),
  ];
  const sessionSourceOptions = [
    { value: 'all', label: 'All sources' },
    ...sourceOptions.map((value) => ({
      value,
      label: getSessionSurfaceLabel(value),
    })),
  ];

  return (
    <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
      <SessionFilterDropdown
        ariaLabel="Session scope"
        icon={<MessagesSquare className="size-4 lg:mr-1.5" />}
        value={scope}
        options={scopeOptions}
        onChange={(value) =>
          updateParams((params) => params.set('scope', value))
        }
      />
      <SessionFilterDropdown
        ariaLabel="Session status"
        icon={<Activity className="size-4 lg:mr-1.5" />}
        value={status}
        options={sessionStatusOptions}
        onChange={(value) =>
          updateParams((params) => {
            if (value === 'all') params.delete('status');
            else params.set('status', value);
          })
        }
      />
      <TaskFilters
        userId="all"
        repositoryName={null}
        pullRequest={null}
        model={null}
        timePeriod={timePeriod}
        onUserChange={() => undefined}
        onRepositoryChange={() => undefined}
        onPullRequestChange={() => undefined}
        onModelChange={() => undefined}
        onTimePeriodChange={(period) =>
          updateParams((params) => {
            if (period === 'all') params.delete('period');
            else params.set('period', String(period));
          })
        }
        showUser={false}
        showRepository={false}
        showPullRequest={false}
        showModel={false}
        showTaskType={false}
      />

      {showAdvancedFilters ? (
        <>
          <TaskFilters
            userId={userId ?? 'all'}
            repositoryName={repository}
            pullRequest={pullRequest}
            model={model}
            timePeriod={timePeriod}
            onUserChange={(value) =>
              updateNullableParam(
                'user',
                value && value !== 'all' ? value : null,
              )
            }
            onRepositoryChange={(value) =>
              updateNullableParam('repository', value)
            }
            onPullRequestChange={(value) =>
              updateNullableParam('pullRequest', value)
            }
            onModelChange={(value) => updateNullableParam('model', value)}
            onTimePeriodChange={() => undefined}
            showTimePeriod={false}
            showTaskType={false}
          />
          <SessionFilterDropdown
            ariaLabel="Session source"
            icon={<Share2 className="size-4 lg:mr-1.5" />}
            value={source}
            options={sessionSourceOptions}
            onChange={(value) =>
              updateParams((params) => {
                if (value === 'all') params.delete('source');
                else params.set('source', value);
              })
            }
          />
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn('size-8', showAdvancedFilters && 'bg-accent')}
          aria-label="Toggle advanced filters"
          aria-pressed={showAdvancedFilters}
          title="Advanced filters"
          onClick={() =>
            setShowAdvancedFilters((current) => {
              const next = !current;
              writeStoredPreference(ADVANCED_FILTERS_STORAGE_KEY, String(next));
              return next;
            })
          }
        >
          <SlidersHorizontal />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn('size-8', (showSearch || query) && 'bg-accent')}
          aria-label="Toggle session search"
          aria-pressed={showSearch}
          title="Search sessions"
          onClick={() => setShowSearch((current) => !current)}
        >
          <Search />
        </Button>
        {showSearch ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              updateNullableParam(
                'q',
                String(form.get('q') ?? '').trim() || null,
              );
            }}
          >
            <Input
              ref={searchInputRef}
              name="q"
              defaultValue={query}
              aria-label="Search sessions"
              placeholder="Search..."
              className="h-8 w-40 sm:w-48"
            />
          </form>
        ) : null}
        <div className="flex items-center rounded-lg border border-border p-0.5">
          <Button
            variant={view === 'list' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => {
              writeStoredPreference(SESSIONS_VIEW_STORAGE_KEY, 'list');
              updateParams((params) => params.set('view', 'list'));
            }}
            aria-label="List view"
            aria-pressed={view === 'list'}
            title="List view"
            className="rounded-r-none"
          >
            <List />
          </Button>
          <Button
            variant={view === 'board' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => {
              writeStoredPreference(SESSIONS_VIEW_STORAGE_KEY, 'board');
              updateParams((params) => params.set('view', 'board'));
            }}
            aria-label="Board view"
            aria-pressed={view === 'board'}
            title="Board view"
            className="rounded-l-none"
          >
            <Columns3 />
          </Button>
        </div>
      </div>
    </div>
  );
}
