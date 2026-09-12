'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMediaQuery } from 'usehooks-ts';

import {
  Button,
  MessageSquareIcon,
  PanelLeftClose,
  PanelLeftOpen,
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
        className="relative z-nav-header h-full w-12 shrink-0 md:hidden"
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 flex w-12 flex-col overflow-hidden border-r bg-card px-1 py-2 transition-[width,box-shadow] duration-200',
            isExpanded && 'w-56 shadow-xl',
          )}
        >
          <div
            className={cn(
              'flex h-10 shrink-0 items-center',
              isExpanded ? 'justify-between gap-2' : 'justify-center',
            )}
          >
            {isExpanded ? (
              <span className="min-w-0 flex-1 truncate pl-2 text-sm font-semibold">
                Recent sessions
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 text-muted-foreground"
              aria-expanded={isExpanded}
              aria-label={
                isExpanded
                  ? 'Collapse recent sessions'
                  : 'Expand recent sessions'
              }
              onClick={() => navigationState?.setSwitcherExpanded(!isExpanded)}
            >
              {isExpanded ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto py-1">
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
                  title={!isExpanded ? session.title : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={session.title}
                  onNavigate={() => {
                    if (!isActive) {
                      navigationState?.prepareSessionSwitch(session.id);
                    }
                  }}
                  className={cn(
                    'ph-no-capture flex h-10 w-full items-center rounded-lg px-1 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-foreground text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <span className="relative flex size-8 shrink-0 items-center justify-center">
                    <MessageSquareIcon className="size-4" aria-hidden="true" />
                    {needsAttention ? (
                      <span
                        className="absolute right-0 top-0 size-2 rounded-full bg-warning ring-2 ring-card"
                        aria-label="Needs attention"
                      />
                    ) : isRunning ? (
                      <span
                        className="absolute right-0 top-0 size-2 rounded-full border border-current bg-card opacity-70"
                        aria-label="Running"
                      />
                    ) : null}
                  </span>
                  {isExpanded ? (
                    <span className="min-w-0 flex-1 truncate pr-2">
                      {session.title}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-10 w-full shrink-0 justify-start px-1 text-muted-foreground',
              !isExpanded && 'justify-center',
            )}
            aria-label="New Session"
            onClick={() => setIsNewTaskDialogOpen(true)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center">
              <Plus />
            </span>
            {isExpanded ? <span className="pr-2">New Session</span> : null}
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
