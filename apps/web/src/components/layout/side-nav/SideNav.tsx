'use client';

import { type ComponentProps, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleIconTrigger,
  CollapsibleTrigger,
  ListChevronsUpDown,
  Settings,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  VectorSquare,
} from '@/components/system';
import { RoomoteWordmark, UserMenu } from '@/components/layout';
import { useCommandPalette } from '@/components/layout/CommandPaletteContext';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system/primitives/tooltip';
import {
  useHydrateLayoutStore,
  useLayoutStore,
} from '@/hooks/useLayoutOptions';
import { useRecentTasks } from '@/hooks/useRecentTasks';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useLiveTaskStatus, useTaskPins } from '@/hooks/tasks';
import { useTRPC } from '@/trpc/client';
import { sortTasksByLastActive } from '@/lib/task-order';
import { cn } from '@/lib/utils';

import { getVisiblePrimaryNavItems } from '../navigation-items';
import { SideNavItem } from './SideNavItem';
import { SideNavTaskItem } from './SideNavTaskItem';

const SIDE_NAV_MAX_VISIBLE_TASKS = 20;
const SIDE_NAV_INCLUDE_IDS_LIMIT = 20;
const SIDEBAR_LOGO_SRC = '/logos/r.svg';
const NO_ENVIRONMENT_GROUP_KEY = '__no_environment__';
const NO_ENVIRONMENT_GROUP_LABEL = 'Other';
type SideNavQuickAccessTask = ComponentProps<typeof SideNavTaskItem>['task'];

type SideNavTaskGroup = {
  key: string;
  label: string;
  tasks: SideNavQuickAccessTask[];
};

function getMissingEnvironmentLabel(environmentId: string): string {
  return `Environment ${environmentId.slice(0, 8)}`;
}

export function getTaskIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/task\/([^/]+)/);
  return match?.[1] ?? null;
}

export const SideNav = () => {
  useHydrateLayoutStore();

  const pathname = usePathname();
  const { setOpen: openCommandPalette } = useCommandPalette();
  const { featureFlags, isAdmin } = useAuthorizedUser();
  const hasHydrated = useLayoutStore((state) => state.hasHydrated);
  const persistedIsSideNavExpanded = useLayoutStore(
    (state) => state.isSideNavExpanded,
  );
  const setSideNavExpanded = useLayoutStore(
    (state) => state.setSideNavExpanded,
  );
  const isSideNavExpanded = hasHydrated && persistedIsSideNavExpanded;
  const trpc = useTRPC();
  const { recentTaskIds } = useRecentTasks();
  const { pinnedTaskIds, setTaskPinned, isTaskPinMutationPending } =
    useTaskPins();

  const currentTaskId = useMemo(
    () => getTaskIdFromPathname(pathname),
    [pathname],
  );
  const activeLiveTaskStatus = useLiveTaskStatus(currentTaskId);

  const includeIds = useMemo(
    () =>
      [...new Set([...pinnedTaskIds, ...recentTaskIds])].slice(
        0,
        SIDE_NAV_INCLUDE_IDS_LIMIT,
      ),
    [pinnedTaskIds, recentTaskIds],
  );

  const { data: searchedTasks = [] } = useQuery(
    trpc.tasks.search.queryOptions(
      {
        limit: SIDE_NAV_MAX_VISIBLE_TASKS,
        includeIds: includeIds.length > 0 ? includeIds : undefined,
      },
      {
        enabled: isSideNavExpanded,
        placeholderData: keepPreviousData,
      },
    ),
  );

  const quickAccessTasks = useMemo(() => {
    if (searchedTasks.length === 0) {
      return [];
    }

    const tasksById = new Map(
      sortTasksByLastActive(searchedTasks).map((task) => [task.id, task]),
    );
    const pinnedSet = new Set(pinnedTaskIds);

    const pinnedTasks = pinnedTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is NonNullable<typeof task> => !!task);

    const remainingTasks = sortTasksByLastActive(searchedTasks).filter(
      (task) => !pinnedSet.has(task.id),
    );

    return [...pinnedTasks, ...remainingTasks].slice(
      0,
      SIDE_NAV_MAX_VISIBLE_TASKS,
    );
  }, [searchedTasks, pinnedTaskIds]);

  const pinnedTaskIdSet = useMemo(
    () => new Set(pinnedTaskIds),
    [pinnedTaskIds],
  );
  const pinnedQuickAccessTasks = useMemo(
    () => quickAccessTasks.filter((task) => pinnedTaskIdSet.has(task.id)),
    [pinnedTaskIdSet, quickAccessTasks],
  );
  const nonPinnedQuickAccessTasks = useMemo(
    () => quickAccessTasks.filter((task) => !pinnedTaskIdSet.has(task.id)),
    [pinnedTaskIdSet, quickAccessTasks],
  );
  const groupedEnvironmentIds = useMemo(
    () => [
      ...new Set(
        nonPinnedQuickAccessTasks
          .map((task) => task.cloudJob?.payload?.environmentId)
          .filter((id): id is string => !!id),
      ),
    ],
    [nonPinnedQuickAccessTasks],
  );
  const { data: groupedEnvironments = [] } = useQuery(
    trpc.environments.namesByIds.queryOptions(
      { ids: groupedEnvironmentIds },
      {
        enabled: isSideNavExpanded && groupedEnvironmentIds.length > 0,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const environmentNameById = useMemo(
    () =>
      new Map(
        groupedEnvironments.map((environment) => [
          environment.id,
          environment.name,
        ]),
      ),
    [groupedEnvironments],
  );
  const groupedRecentQuickAccessTasks = useMemo(() => {
    const groups = new Map<string, SideNavTaskGroup>();

    for (const task of nonPinnedQuickAccessTasks) {
      const environmentId = task.cloudJob?.payload?.environmentId ?? null;
      const groupKey = environmentId ?? NO_ENVIRONMENT_GROUP_KEY;
      const existingGroup = groups.get(groupKey);

      if (existingGroup) {
        existingGroup.tasks.push(task);
        continue;
      }

      groups.set(groupKey, {
        key: groupKey,
        label: environmentId
          ? (environmentNameById.get(environmentId) ??
            getMissingEnvironmentLabel(environmentId))
          : NO_ENVIRONMENT_GROUP_LABEL,
        tasks: [task],
      });
    }

    return Array.from(groups.values());
  }, [environmentNameById, nonPinnedQuickAccessTasks]);
  const visibleNavItems = useMemo(
    () => getVisiblePrimaryNavItems(featureFlags, { isAdmin }),
    [featureFlags, isAdmin],
  );

  return (
    <nav
      className={cn(
        'hidden md:flex shrink-0 bg-card flex-col md:pt-3 pb-4 h-effective-viewport sticky top-0 z-nav-header overflow-hidden pl-2',
        hasHydrated ? 'transition-all duration-200' : 'transition-none',
        isSideNavExpanded
          ? 'w-(--sidebar-width) items-stretch'
          : 'w-12 items-start',
      )}
    >
      {/* Logo */}
      {isSideNavExpanded ? (
        <div className="flex w-full items-center justify-between gap-3 px-2 py-1 shrink-0">
          <Link href="/" className="min-w-0 flex-1">
            <RoomoteWordmark
              className="h-7 transition-all duration-300 hover:opacity-80"
              aria-label="Roomote"
            />
          </Link>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close sidebar"
            className="size-8 rounded-full text-muted-foreground hover:text-accent-foreground"
            onClick={() => setSideNavExpanded(false)}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
      ) : (
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open sidebar"
              className="group relative size-10 rounded-full text-muted-foreground"
              onClick={() => setSideNavExpanded(true)}
            >
              <Image
                src={SIDEBAR_LOGO_SRC}
                alt=""
                width={28}
                height={28}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 m-auto h-7 w-7 opacity-100 transition-opacity duration-200 group-hover:opacity-0 dark:invert"
              />
              <PanelLeftOpen
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 m-auto size-6 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            Open sidebar
          </TooltipContent>
        </Tooltip>
      )}

      {/* Nav items — pinned to top */}
      <div className="mt-6 flex w-full shrink-0 flex-col gap-1">
        {visibleNavItems.map(
          ({ icon, href, label, description, matchExact, matchPaths }) => (
            <SideNavItem
              key={href}
              icon={icon}
              href={href}
              tooltip={label}
              description={description}
              expanded={isSideNavExpanded}
              active={
                matchExact
                  ? matchPaths.includes(pathname)
                  : matchPaths.some((path) => pathname.startsWith(path))
              }
            />
          ),
        )}

        <SideNavItem
          icon={Settings}
          href="/settings"
          tooltip="Settings"
          description="Manage your settings"
          expanded={isSideNavExpanded}
          active={pathname.startsWith('/settings')}
        />

        <SideNavItem
          icon={Search}
          label="Search"
          tooltip="Search (⌘K)"
          description="Search and navigate"
          expanded={isSideNavExpanded}
          active={false}
          onClick={() => openCommandPalette(true)}
        />

        {!isSideNavExpanded && (
          <SideNavItem
            icon={ListChevronsUpDown}
            label="Expand sidebar"
            tooltip="Expand sidebar"
            description="Access recent tasks from here"
            expanded={false}
            active={false}
            aria-label="Expand sidebar"
            onClick={() => setSideNavExpanded(true)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1">
        {isSideNavExpanded && quickAccessTasks.length > 0 && (
          <div className="flex h-full min-h-0 flex-col w-(--sidebar-width) ">
            <hr className="mt-4 mb-3 w-full shrink-0 border-input/50" />

            <div className="min-h-0 flex-1 overflow-x-clip overflow-y-auto scroll-thin pr-1 space-y-4">
              {pinnedQuickAccessTasks.length > 0 && (
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold pl-2 py-1">
                    Pinned tasks
                  </h3>
                  {pinnedQuickAccessTasks.map((task) => (
                    <SideNavTaskItem
                      key={task.id}
                      task={task}
                      liveStatus={
                        currentTaskId === task.id ? activeLiveTaskStatus : null
                      }
                      isActive={currentTaskId === task.id}
                      isPinned={pinnedTaskIdSet.has(task.id)}
                      isPinPending={isTaskPinMutationPending(task.id)}
                      expanded
                      onTogglePin={(nextPinned) =>
                        setTaskPinned(task.id, nextPinned)
                      }
                    />
                  ))}
                </div>
              )}

              {groupedRecentQuickAccessTasks.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-semibold pl-2 py-1">
                    Recent tasks
                  </h3>
                  {groupedRecentQuickAccessTasks.map((group) => (
                    <Collapsible key={group.key} defaultOpen className="group">
                      <CollapsibleTrigger className="flex h-8 w-full cursor-pointer items-center rounded-lg px-2 mt-1 text-left text-foreground/50 transition-colors hover:text-accent-foreground">
                        <span className="flex min-w-0 items-center gap-2 w-full">
                          <CollapsibleIconTrigger
                            icon={VectorSquare}
                            className="size-3.5"
                            iconClassName="size-3.5"
                          />
                          <span className="truncate text-sm grow">
                            {group.label}
                          </span>
                        </span>
                      </CollapsibleTrigger>

                      <CollapsibleContent className="mt-1 space-y-1">
                        {group.tasks.map((task) => (
                          <SideNavTaskItem
                            key={task.id}
                            task={task}
                            liveStatus={
                              currentTaskId === task.id
                                ? activeLiveTaskStatus
                                : null
                            }
                            isActive={currentTaskId === task.id}
                            isPinned={pinnedTaskIdSet.has(task.id)}
                            isPinPending={isTaskPinMutationPending(task.id)}
                            expanded
                            onTogglePin={(nextPinned) =>
                              setTaskPinned(task.id, nextPinned)
                            }
                          />
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom section — pinned to bottom */}
      {isSideNavExpanded && (
        <hr
          className={`mt-4 mb-3 w-full shrink-0 border-input/50 transition-opacity opacity-${isSideNavExpanded ? '100' : '0'}`}
        />
      )}

      <div className="w-full shrink-0">
        <div className={cn('mt-2 flex w-full px-1')}>
          <UserMenu expanded={isSideNavExpanded} />
        </div>
      </div>
    </nav>
  );
};
