'use client';

import Link from 'next/link';

import { LayoutGrid } from '@/components/system';
import { cn } from '@/lib/utils';

export function ArtifactsBadge({
  count,
  href,
  className,
}: {
  count: number;
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 hover:underline',
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <LayoutGrid className="size-3.5 shrink-0" />
      <span className="truncate">
        {count} {count === 1 ? 'artifact' : 'artifacts'}
      </span>
    </Link>
  );
}
