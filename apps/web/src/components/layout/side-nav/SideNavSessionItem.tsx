import Link from 'next/link';

import { cn } from '@/lib/utils';

type SideNavSessionItemProps = {
  session: {
    id: string;
    title: string;
  };
  isActive: boolean;
};

export function SideNavSessionItem({
  session,
  isActive,
}: SideNavSessionItemProps) {
  return (
    <Link
      href={`/sessions/${session.id}`}
      aria-label={session.title}
      className={cn(
        'ph-no-capture flex min-h-10 w-full items-center rounded-lg pl-10.5 transition-all',
        isActive
          ? 'pr-2 bg-foreground text-accent-bright-foreground dark:bg-accent-foreground dark:text-card'
          : 'text-muted-foreground hover:text-accent-foreground',
      )}
    >
      <span className="min-w-0 flex-1 line-clamp-1 text-sm font-medium leading-5 wrap-break-word">
        {session.title}
      </span>
    </Link>
  );
}
