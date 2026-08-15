import { useEffect, useMemo, useState } from 'react';

import { ALL_REPOSITORIES, type TaskWorkflow } from '@roomote/types';

import { type TimePeriodFilter, HAS_PULL_REQUEST_FILTER_VALUE } from '@/types';

import {
  DEFAULT_VISIBLE_TASK_WORKFLOWS,
  HIDDEN_TASK_WORKFLOWS,
} from '@/lib/task-categories';
import {
  formatAutomationLabel,
  parseCreatorFilterValue,
} from '@/lib/task-creator-filter';
import { cn } from '@/lib/utils';

import {
  useUsersForFilter,
  useRepositoriesForFilter,
  useEnvironmentsForFilter,
  useModelsForFilter,
  usePullRequestsForFilter,
} from '@/hooks/filters';

import {
  Calendar,
  ChevronDown,
  VectorSquare,
  Brain,
  GitPullRequest,
  Shapes,
  Search,
  CircleUserRound,
  X,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  Button,
  Input,
} from '@/components/system';

import {
  getTaskTypeFilterButtonLabel,
  isDefaultTaskTypeFilterSelection,
} from './taskTypeFilter';

type TaskFiltersProps = {
  // Filter values.
  userId: string | null;
  defaultUserId?: string;
  category?: string | null;
  repositoryName: string | null;
  pullRequest: string | null;
  model: string | null;
  taskTypes?: TaskWorkflow[];
  timePeriod: TimePeriodFilter;

  // Change handlers.
  onUserChange: (id: string | null) => void;
  onRepositoryChange: (name: string | null) => void;
  onPullRequestChange: (pullRequest: string | null) => void;
  onModelChange: (model: string | null) => void;
  onTaskTypesChange?: (taskTypes: TaskWorkflow[]) => void;
  onTimePeriodChange: (period: TimePeriodFilter) => void;

  // Visibility controls (all shown by default).
  showUser?: boolean;
  showRepository?: boolean;
  showPullRequest?: boolean;
  showModel?: boolean;
  showTaskType?: boolean;
  showTimePeriod?: boolean;
};

export const TaskFilters = ({
  userId: filterUserId,
  defaultUserId,
  category = null,
  repositoryName,
  pullRequest,
  model,
  taskTypes = [],
  timePeriod,
  onUserChange,
  onRepositoryChange,
  onPullRequestChange,
  onModelChange,
  onTaskTypesChange,
  onTimePeriodChange,
  showUser = true,
  showRepository = true,
  showPullRequest = true,
  showModel = true,
  showTaskType = false,
  showTimePeriod = true,
}: TaskFiltersProps) => {
  // `null` means server defaults to the current user; 'all' means explicitly no user filter.
  const effectiveUserId =
    filterUserId === null ? (defaultUserId ?? null) : filterUserId;
  const userIdForOptionQueries = filterUserId === 'all' ? null : filterUserId;

  // Active when a specific user is selected (either explicitly or via default).
  const isUserActive = effectiveUserId !== null && filterUserId !== 'all';

  const isRepositoryActive = repositoryName !== null;
  const isPullRequestActive = pullRequest !== null;
  const isModelActive = model !== null;
  const isTaskTypeActive = !isDefaultTaskTypeFilterSelection(taskTypes);
  const isTimePeriodActive = timePeriod !== 'all';

  const activeFilterStyle =
    'text-accent-foreground font-medium border-b-2 border-accent-foreground focus-visible:border-accent-foreground rounded-none';
  const defaultFilterStyle =
    'text-muted-foreground hover:text-accent-foreground';

  const [prSearch, setPrSearch] = useState('');
  const [debouncedPrSearch, setDebouncedPrSearch] = useState('');
  const [isPrDropdownOpen, setIsPrDropdownOpen] = useState(false);
  const [selectedPrLabel, setSelectedPrLabel] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedPrSearch(prSearch), 250);
    return () => clearTimeout(handle);
  }, [prSearch]);

  const { data: userOptions = [] } = useUsersForFilter({
    repositoryName,
    category,
    timePeriod,
  });

  const { humanUserOptions, automationUserOptions } = useMemo(() => {
    const humans: typeof userOptions = [];
    const automations: typeof userOptions = [];

    for (const option of userOptions) {
      if (parseCreatorFilterValue(option.value).kind === 'automation') {
        automations.push(option);
      } else {
        humans.push(option);
      }
    }

    return { humanUserOptions: humans, automationUserOptions: automations };
  }, [userOptions]);

  const { data: rawRepositories = [] } = useRepositoriesForFilter({
    userId: userIdForOptionQueries,
    category,
    timePeriod,
  });

  // Filter out the __all_repositories__ sentinel — it's not a real repository.
  const repositories = useMemo(
    () => rawRepositories.filter((r) => r.value !== ALL_REPOSITORIES),
    [rawRepositories],
  );

  const { data: environmentOptions = [] } = useEnvironmentsForFilter();
  const { data: modelOptions = [] } = useModelsForFilter({
    userId: userIdForOptionQueries,
    category,
    repositoryName,
    timePeriod,
  });

  const { data: pullRequests = [] } = usePullRequestsForFilter({
    userId: userIdForOptionQueries,
    category,
    repositoryName,
    timePeriod,
    search: debouncedPrSearch,
  });

  useEffect(() => {
    if (!pullRequest) {
      setSelectedPrLabel(null);
      return;
    }

    if (pullRequest === HAS_PULL_REQUEST_FILTER_VALUE) {
      return;
    }

    const match = pullRequests.find((pr) => pr.value === pullRequest);

    if (match) {
      setSelectedPrLabel((current) =>
        current === match.label ? current : match.label,
      );
    }
  }, [pullRequest, pullRequests]);

  const pullRequestButtonLabel = useMemo(() => {
    if (pullRequest === HAS_PULL_REQUEST_FILTER_VALUE) {
      return 'Has PR';
    }

    if (pullRequest) {
      return selectedPrLabel ?? 'PR';
    }

    return 'PR';
  }, [pullRequest, selectedPrLabel]);

  const visibleTaskTypes = DEFAULT_VISIBLE_TASK_WORKFLOWS;
  const hiddenTaskTypes = useMemo(() => [...HIDDEN_TASK_WORKFLOWS], []);
  const taskTypeButtonLabel = useMemo(
    () => getTaskTypeFilterButtonLabel(taskTypes),
    [taskTypes],
  );

  const toggleTaskType = (taskType: TaskWorkflow) => {
    if (!onTaskTypesChange) {
      return;
    }

    const nextTaskTypes = taskTypes.includes(taskType)
      ? taskTypes.filter((value) => value !== taskType)
      : [...taskTypes, taskType];

    onTaskTypesChange(nextTaskTypes);
  };

  return (
    <div className="flex flex-wrap md:flex-row space-y-0 items-start md:items-center justify-start md:pb-0 gap-x-2 md:gap-y-0">
      {/* Left side: Task Source Tabs */}

      {/* User dropdown */}
      {showUser && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isUserActive ? activeFilterStyle : defaultFilterStyle,
                !isUserActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <CircleUserRound className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {filterUserId === 'all'
                  ? 'Any User'
                  : effectiveUserId
                    ? effectiveUserId === defaultUserId
                      ? 'You'
                      : (userOptions.find((u) => u.value === effectiveUserId)
                          ?.label ?? 'User')
                    : 'You'}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sm:max-w-64">
            <DropdownMenuCheckboxItem
              onClick={() => onUserChange(null)}
              className="cursor-pointer"
              checked={filterUserId === 'all'}
            >
              Any User
            </DropdownMenuCheckboxItem>
            {humanUserOptions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Users</DropdownMenuLabel>
              </>
            )}
            {humanUserOptions.map((user) => (
              <DropdownMenuCheckboxItem
                key={user.value}
                onClick={() => onUserChange(user.value)}
                checked={effectiveUserId === user.value}
                className="cursor-pointer"
              >
                <span className="truncate">{user.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {automationUserOptions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Automations</DropdownMenuLabel>
              </>
            )}
            {automationUserOptions.map((user) => (
              <DropdownMenuCheckboxItem
                key={user.value}
                onClick={() => onUserChange(user.value)}
                checked={effectiveUserId === user.value}
                className="cursor-pointer"
              >
                <span className="truncate">{user.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Environment (Repositories + Environments) dropdown */}
      {showRepository && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isRepositoryActive ? activeFilterStyle : defaultFilterStyle,
                !isRepositoryActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <VectorSquare className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {repositoryName
                  ? repositoryName.startsWith('env:')
                    ? (environmentOptions.find(
                        (e) => e.value === repositoryName.slice(4),
                      )?.label ?? repositoryName)
                    : repositoryName
                  : 'Environment'}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sm:max-w-64">
            <DropdownMenuCheckboxItem
              onClick={() => onRepositoryChange(null)}
              className="cursor-pointer"
              checked={repositoryName === null}
            >
              Any Environment
            </DropdownMenuCheckboxItem>
            {environmentOptions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Environments</DropdownMenuLabel>
              </>
            )}
            {environmentOptions.map((env) => (
              <DropdownMenuCheckboxItem
                key={env.value}
                onClick={() => onRepositoryChange(`env:${env.value}`)}
                checked={repositoryName === `env:${env.value}`}
                className="cursor-pointer"
              >
                <span className="truncate">{env.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {repositories.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Repositories</DropdownMenuLabel>
              </>
            )}
            {repositories.map((repo) => (
              <DropdownMenuCheckboxItem
                key={repo.value}
                onClick={() => onRepositoryChange(repo.value)}
                checked={repositoryName === repo.value}
                className="cursor-pointer"
              >
                <span className="truncate">{repo.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Pull request dropdown */}
      {showPullRequest && (
        <DropdownMenu
          open={isPrDropdownOpen}
          onOpenChange={(open) => {
            setIsPrDropdownOpen(open);
            if (open) {
              setPrSearch('');
              setDebouncedPrSearch('');
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isPullRequestActive ? activeFilterStyle : defaultFilterStyle,
                !isPullRequestActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <GitPullRequest className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {pullRequestButtonLabel}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sm:max-w-80">
            <div className="relative">
              <Search className="size-4 absolute left-2 top-2 text-muted-foreground" />
              <Input
                placeholder="Search by PR number..."
                pattern="\d*"
                value={prSearch}
                onChange={(e) => setPrSearch(e.target.value.replace(/\D/g, ''))}
                className="h-8 border-none pl-8"
                onClick={(e) => e.stopPropagation()}
              />
              <X
                className={cn(
                  'size-4 cursor-pointer absolute right-2 top-2 text-muted-foreground px-1! gap-0',
                  prSearch.length === 0 && 'hidden',
                )}
                onClick={(_e) => setPrSearch('')}
              />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              onClick={() => {
                setSelectedPrLabel(null);
                onPullRequestChange(null);
              }}
              className="cursor-pointer"
              checked={pullRequest === null}
            >
              All
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              onClick={() => {
                setSelectedPrLabel('Has PR');
                onPullRequestChange(HAS_PULL_REQUEST_FILTER_VALUE);
              }}
              className="cursor-pointer"
              checked={pullRequest === HAS_PULL_REQUEST_FILTER_VALUE}
            >
              Has PR
            </DropdownMenuCheckboxItem>
            {pullRequests.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  Recent PRs (search for more)
                </DropdownMenuLabel>
              </>
            )}
            {pullRequests.map((pr) => (
              <DropdownMenuCheckboxItem
                key={pr.value}
                onClick={() => {
                  setSelectedPrLabel(pr.label);
                  onPullRequestChange(pr.value);
                }}
                checked={pullRequest === pr.value}
                className="cursor-pointer"
              >
                <div className="flex min-w-0 w-full flex-col text-left">
                  <span className="truncate">{pr.label}</span>
                  {pr.subLabel && (
                    <span className="truncate text-xs text-muted-foreground">
                      {pr.subLabel}
                    </span>
                  )}
                </div>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showModel && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isModelActive ? activeFilterStyle : defaultFilterStyle,
                !isModelActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <Brain className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {model
                  ? (modelOptions.find((option) => option.value === model)
                      ?.label ?? model)
                  : 'Model'}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sm:max-w-72">
            <DropdownMenuCheckboxItem
              onClick={() => onModelChange(null)}
              checked={model === null}
              className="cursor-pointer"
            >
              Any Model
            </DropdownMenuCheckboxItem>
            {modelOptions.length > 0 && <DropdownMenuSeparator />}
            {modelOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                onClick={() => onModelChange(option.value)}
                checked={model === option.value}
                className="cursor-pointer"
              >
                <div className="flex min-w-0 w-full flex-col text-left">
                  <span className="truncate">{option.label}</span>
                  {option.subLabel && (
                    <span className="truncate text-xs text-muted-foreground">
                      {option.subLabel}
                    </span>
                  )}
                </div>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showTaskType && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isTaskTypeActive ? activeFilterStyle : defaultFilterStyle,
                !isTaskTypeActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <Shapes className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {taskTypeButtonLabel}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="sm:max-w-80">
            <DropdownMenuCheckboxItem
              checked={isDefaultTaskTypeFilterSelection(taskTypes)}
              className="cursor-pointer"
              onSelect={(event) => {
                event.preventDefault();
                onTaskTypesChange?.([...visibleTaskTypes]);
              }}
            >
              Visible defaults
            </DropdownMenuCheckboxItem>
            {visibleTaskTypes.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Visible types</DropdownMenuLabel>
              </>
            )}
            {visibleTaskTypes.map((taskType) => (
              <DropdownMenuCheckboxItem
                key={taskType}
                checked={taskTypes.includes(taskType)}
                className="cursor-pointer"
                onSelect={(event) => {
                  event.preventDefault();
                  toggleTaskType(taskType);
                }}
              >
                <span className="truncate">
                  {formatAutomationLabel(taskType)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            {hiddenTaskTypes.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Hidden types</DropdownMenuLabel>
              </>
            )}
            {hiddenTaskTypes.map((taskType) => (
              <DropdownMenuCheckboxItem
                key={taskType}
                checked={taskTypes.includes(taskType)}
                className="cursor-pointer"
                onSelect={(event) => {
                  event.preventDefault();
                  toggleTaskType(taskType);
                }}
              >
                <span className="truncate">
                  {formatAutomationLabel(taskType)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Time period dropdown */}
      {showTimePeriod && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                isTimePeriodActive ? activeFilterStyle : defaultFilterStyle,
                !isTimePeriodActive && 'font-normal',
                'px-1! gap-0',
              )}
            >
              <Calendar className="size-4 lg:mr-1.5" />
              <span className="hidden lg:inline-block truncate max-w-48 align-middle">
                {timePeriod === 'all'
                  ? 'Time'
                  : timePeriod === 1
                    ? 'Today'
                    : timePeriod === 7
                      ? 'Last 7 Days'
                      : timePeriod === 30
                        ? 'Last 30 Days'
                        : timePeriod === 90
                          ? 'Last 90 Days'
                          : 'Time'}
              </span>
              <ChevronDown className="ml-1 h-3 w-3 hidden lg:inline-block align-middle shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="">
            <DropdownMenuCheckboxItem
              onClick={() => onTimePeriodChange('all')}
              className="cursor-pointer"
              checked={timePeriod === 'all'}
            >
              All Time
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              onClick={() => onTimePeriodChange(1)}
              className="cursor-pointer"
              checked={timePeriod === 1}
            >
              Today
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              onClick={() => onTimePeriodChange(7)}
              className="cursor-pointer"
              checked={timePeriod === 7}
            >
              Last 7 Days
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              onClick={() => onTimePeriodChange(30)}
              className="cursor-pointer"
              checked={timePeriod === 30}
            >
              Last 30 Days
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              onClick={() => onTimePeriodChange(90)}
              className="cursor-pointer"
              checked={timePeriod === 90}
            >
              Last 90 Days
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};
