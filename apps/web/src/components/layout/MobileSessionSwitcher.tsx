'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMediaQuery } from 'usehooks-ts';

import {
  Button,
  ChevronDown,
  ChevronUp,
  MessageSquareIcon,
  Plus,
} from '@/components/system';
import { NewTaskDialog } from '@/components/tasks/NewTaskDialog';
import { useSessionNavigationState } from '@/hooks/useSessionNavigationState';
import { useTRPC } from '@/trpc/client';
import { cn } from '@/lib/utils';

const MOBILE_SESSION_LIMIT = 20;

function getSessionId(pathname: string) {
  return pathname.match(/^\/sessions\/([^/]+)/)?.[1] ?? null;
}

export function MobileSessionSwitcher() {
  const pathname = usePathname();
  const currentSessionId = getSessionId(pathname);
  const isMobile = useMediaQuery('(max-width: 767px)', {
    initializeWithValue: false,
  });
  const navigationState = useSessionNavigationState();
  const isExpanded = navigationState?.isSwitcherExpanded ?? true;
  const [isNewTaskDialogOpen, setIsNewTaskDialogOpen] = useState(false);
  const trpc = useTRPC();
  const { data, refetch } = useQuery(
    trpc.sessions.list.queryOptions(
      { ownedOnly: true, limit: MOBILE_SESSION_LIMIT },
      {
        enabled: isMobile && currentSessionId !== null,
        placeholderData: keepPreviousData,
      },
    ),
  );
  const sessions = data?.sessions ?? [];

  useEffect(() => {
    if (isMobile && currentSessionId) void refetch();
  }, [currentSessionId, isMobile, refetch]);

  if (!currentSessionId) return null;

  return (
    <>
      <nav
        aria-label="Recent sessions"
        className="shrink-0 border-b bg-card px-2 py-1.5 md:hidden"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size={isExpanded ? 'icon' : 'sm'}
            className={cn(
              'shrink-0 text-muted-foreground',
              isExpanded && 'size-9',
            )}
            aria-label={
              isExpanded ? 'Collapse recent sessions' : 'Expand recent sessions'
            }
            onClick={() => navigationState?.setSwitcherExpanded(!isExpanded)}
          >
            {isExpanded ? <ChevronUp /> : <ChevronDown />}
            {!isExpanded ? <span>Sessions</span> : null}
          </Button>
          {isExpanded ? (
            <div className="scroll-thin flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain">
              {sessions.map((session) => {
                const isActive = session.id === currentSessionId;
                const needsAttention =
                  session.unread ||
                  session.cachedStatus === 'needs_input' ||
                  session.cachedStatus === 'blocked';
                const isRunning = session.cachedStatus === 'active';

                return (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.id}`}
                    prefetch
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={session.title}
                    onNavigate={() => {
                      if (!isActive) {
                        navigationState?.prepareSessionSwitch(session.id);
                      }
                    }}
                    className={cn(
                      'ph-no-capture flex h-9 min-w-30 max-w-40 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'border-accent-foreground bg-foreground text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
                        : 'border-border bg-background text-muted-foreground hover:text-accent-foreground',
                    )}
                  >
                    <MessageSquareIcon
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {session.title}
                    </span>
                    {needsAttention ? (
                      <span
                        className="size-2 shrink-0 rounded-full bg-warning"
                        aria-label="Needs attention"
                      />
                    ) : isRunning ? (
                      <span
                        className="size-2 shrink-0 rounded-full border border-current opacity-50"
                        aria-label="Running"
                      />
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-muted-foreground">
              {sessions.find((session) => session.id === currentSessionId)
                ?.title ?? 'Current session'}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-muted-foreground"
            aria-label="New Session"
            onClick={() => setIsNewTaskDialogOpen(true)}
          >
            <Plus />
          </Button>
        </div>
      </nav>
      <NewTaskDialog
        open={isNewTaskDialogOpen}
        onOpenChange={setIsNewTaskDialogOpen}
      />
    </>
  );
}
