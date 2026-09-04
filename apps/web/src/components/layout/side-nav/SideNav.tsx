'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import {
  Button,
  ListChevronsUpDown,
  Settings,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from '@/components/system';
import { ChatWidgetSideNavItem } from '@/components/layout/ChatWidgetButton';
import { ReleaseNoticeSideNavItem } from '@/components/layout/release-notices';
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
import { useRecentSessions } from '@/hooks/useRecentSessions';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useLiveTaskStatus, useTaskPins } from '@/hooks/tasks';
import { useTRPC } from '@/trpc/client';
import { cn } from '@/lib/utils';
import { NewTaskDialog } from '@/components/tasks/NewTaskDialog';

import {
  getVisiblePrimaryNavItems,
  SETUP_INCOMPLETE_NAV_TOOLTIP,
} from '../navigation-items';
import { SideNavItem } from './SideNavItem';
import { SideNavSessionItem } from './SideNavSessionItem';
import { SideNavTaskItem } from './SideNavTaskItem';

const SIDE_NAV_MAX_VISIBLE_SESSIONS = 20;
const SIDEBAR_LOGO_SRC = '/logos/r.svg';

export function getTaskIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/task\/([^/]+)/);
  return match?.[1] ?? null;
}

export function getSessionIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)/);
  return match?.[1] ?? null;
}

export const SideNav = ({
  setupIncomplete = false,
}: {
  setupIncomplete?: boolean;
}) => {
  useHydrateLayoutStore();

  const pathname = usePathname();
  const { setOpen: openCommandPalette } = useCommandPalette();
  const { isAdmin } = useAuthorizedUser();
  const hasHydrated = useLayoutStore((state) => state.hasHydrated);
  const persistedIsSideNavExpanded = useLayoutStore(
    (state) => state.isSideNavExpanded,
  );
  const setSideNavExpanded = useLayoutStore(
    (state) => state.setSideNavExpanded,
  );
  const isSideNavExpanded = hasHydrated && persistedIsSideNavExpanded;
  const trpc = useTRPC();
  const { recentSessionIds } = useRecentSessions();
  const [isNewTaskDialogOpen, setIsNewTaskDialogOpen] = useState(false);
  const { pinnedTaskIds, setTaskPinned, isTaskPinMutationPending } =
    useTaskPins();

  const currentTaskId = useMemo(
    () => getTaskIdFromPathname(pathname),
    [pathname],
  );
  const currentSessionId = useMemo(
    () => getSessionIdFromPathname(pathname),
    [pathname],
  );
  const activeLiveTaskStatus = useLiveTaskStatus(currentTaskId);

  const { data: searchedTasks = [] } = useQuery(
    trpc.tasks.search.queryOptions(
      {
        limit: Math.max(pinnedTaskIds.length, 1),
        includeIds: pinnedTaskIds.length > 0 ? pinnedTaskIds : undefined,
      },
      {
        enabled: isSideNavExpanded && pinnedTaskIds.length > 0,
        placeholderData: keepPreviousData,
      },
    ),
  );

  const pinnedQuickAccessTasks = useMemo(() => {
    const tasksById = new Map(searchedTasks.map((task) => [task.id, task]));
    return pinnedTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is NonNullable<typeof task> => !!task);
  }, [searchedTasks, pinnedTaskIds]);
  const pinnedTaskIdSet = useMemo(
    () => new Set(pinnedTaskIds),
    [pinnedTaskIds],
  );
  const recentSessionIdsForQuery = useMemo(
    () => recentSessionIds.slice(0, SIDE_NAV_MAX_VISIBLE_SESSIONS),
    [recentSessionIds],
  );
  const { data: recentSessionsResult } = useQuery(
    trpc.sessions.list.queryOptions(
      {
        ids: recentSessionIdsForQuery,
        limit: SIDE_NAV_MAX_VISIBLE_SESSIONS,
      },
      {
        enabled: isSideNavExpanded && recentSessionIdsForQuery.length > 0,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const recentSessions = useMemo(() => {
    const sessionsById = new Map(
      (recentSessionsResult?.sessions ?? []).map((session) => [
        session.id,
        session,
      ]),
    );
    return recentSessionIdsForQuery
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is NonNullable<typeof session> => !!session);
  }, [recentSessionIdsForQuery, recentSessionsResult?.sessions]);
  const visibleNavItems = useMemo(
    () => getVisiblePrimaryNavItems({ isAdmin }),
    [isAdmin],
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
          {setupIncomplete ? (
            <div className="min-w-0 flex-1 opacity-50">
              <RoomoteWordmark className="h-7" aria-label="Roomote" />
            </div>
          ) : (
            <Link href="/" className="min-w-0 flex-1">
              <RoomoteWordmark
                className="h-7 transition-all duration-300 hover:opacity-80"
                aria-label="Roomote"
              />
            </Link>
          )}

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
                priority
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
      <div className="mt-4 flex w-full shrink-0 flex-col gap-1">
        <SideNavItem
          icon={Plus}
          label="New Session"
          tooltip="New Session"
          description="Start a session from anywhere"
          expanded={isSideNavExpanded}
          active={false}
          aria-label="New Session"
          onClick={() => setIsNewTaskDialogOpen(true)}
        />

        {visibleNavItems.map(
          ({
            icon,
            href,
            label,
            description,
            matchExact,
            matchPaths,
            requiresSetup,
          }) => (
            <SideNavItem
              key={href}
              icon={icon}
              href={href}
              label={label}
              aria-label={label}
              tooltip={
                setupIncomplete && requiresSetup
                  ? SETUP_INCOMPLETE_NAV_TOOLTIP
                  : label
              }
              description={
                setupIncomplete && requiresSetup ? undefined : description
              }
              disabled={setupIncomplete && requiresSetup}
              focusableWhenDisabled={setupIncomplete && requiresSetup}
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
            description="Access recent sessions from here"
            expanded={false}
            active={false}
            aria-label="Expand sidebar"
            onClick={() => setSideNavExpanded(true)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-clip">
        {isSideNavExpanded &&
          (pinnedQuickAccessTasks.length > 0 || recentSessions.length > 0) && (
            <div className="flex h-full min-h-0 flex-col pt-4 w-(--sidebar-width)">
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
                  </div>
                )}

                {recentSessions.length > 0 && (
                  <div className="flex flex-col">
                    <h3 className="text-sm font-semibold pl-2 py-1">
                      Recent sessions
                    </h3>
                    {recentSessions.map((session) => (
                      <SideNavSessionItem
                        key={session.id}
                        session={session}
                        isActive={currentSessionId === session.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
      </div>

      <div className="relative z-10 w-full shrink-0 bg-card">
        <div className={cn('mt-2 flex w-full flex-col gap-1 px-1')}>
          <ChatWidgetSideNavItem expanded={isSideNavExpanded} />
          <ReleaseNoticeSideNavItem expanded={isSideNavExpanded} />
          <UserMenu expanded={isSideNavExpanded} />
        </div>
      </div>
      <NewTaskDialog
        open={isNewTaskDialogOpen}
        onOpenChange={setIsNewTaskDialogOpen}
      />
    </nav>
  );
};
