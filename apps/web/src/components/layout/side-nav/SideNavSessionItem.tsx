import Link from 'next/link';

import { useSessionNavigationState } from '@/hooks/useSessionNavigationState';
import { cn } from '@/lib/utils';

type SideNavSessionItemProps = {
  session: {
    id: string;
    title: string;
    cachedStatus?: string | null;
    unread?: boolean;
  };
  isActive: boolean;
  showStatus?: boolean;
};

export function SideNavSessionItem({
  session,
  isActive,
  showStatus = false,
}: SideNavSessionItemProps) {
  const navigationState = useSessionNavigationState();
  const needsAttention =
    session.unread ||
    session.cachedStatus === 'needs_input' ||
    session.cachedStatus === 'blocked';
  const isRunning = session.cachedStatus === 'active';

  return (
    <Link
      href={`/sessions/${session.id}`}
      aria-label={session.title}
      aria-current={isActive ? 'page' : undefined}
      onNavigate={() => {
        if (!isActive) navigationState?.prepareSessionSwitch(session.id);
      }}
      className={cn(
        'ph-no-capture flex min-h-10 w-full items-center rounded-lg pl-2 transition-all',
        isActive
          ? 'pr-2 bg-foreground text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
          : 'text-muted-foreground hover:text-accent-foreground',
      )}
    >
      <span
        title={session.title}
        className="min-w-0 flex-1 line-clamp-1 text-sm font-medium leading-5 wrap-break-word"
      >
        {session.title}
      </span>
      {showStatus && needsAttention ? (
        <span
          className="mr-2 size-2 shrink-0 rounded-full bg-warning"
          aria-label="Needs attention"
        />
      ) : showStatus && isRunning ? (
        <span
          className="mr-2 size-2 shrink-0 rounded-full border border-current opacity-70"
          aria-label="Running"
        />
      ) : null}
    </Link>
  );
}
