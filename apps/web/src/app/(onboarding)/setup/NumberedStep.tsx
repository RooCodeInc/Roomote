import type { ReactNode } from 'react';

export function NumberedStep({
  number,
  children,
  className,
}: {
  number: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${number >= 0 && 'flex gap-2 items-start'} ${className ?? ''}`}
    >
      {number >= 0 && (
        <span className="rounded-full bg-foreground text-background font-bold size-8 inline-flex items-center justify-center shrink-0">
          {number}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}
