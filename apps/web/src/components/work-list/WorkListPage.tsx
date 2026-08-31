import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function WorkListPage({
  toolbar,
  children,
}: {
  toolbar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="border-b-4 border-b-card bg-background p-4">
        {toolbar}
      </div>
      <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  );
}

export function WorkListRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-card">{children}</div>;
}

export function WorkListBoard({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 lg:grid-cols-2 lg:px-2 xl:grid-cols-4">
      {children}
    </div>
  );
}

export function WorkListBoardColumn({
  id,
  label,
  description,
  count,
  dotClassName,
  empty = false,
  children,
  footer,
}: {
  id: string;
  label: string;
  description: string;
  count: number;
  dotClassName: string;
  empty?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingId = `work-list-board-${id}`;

  return (
    <section aria-labelledby={headingId} className="min-w-0 py-2">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="space-y-0 pl-1">
          <div className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full', dotClassName)} />
            <h2 id={headingId} className="text-sm font-semibold">
              {label}
              <span className="ml-1 text-sm text-muted-foreground/50">
                {count}
              </span>
            </h2>
          </div>
          <p className="pl-4 text-xs text-muted-foreground">{description}</p>
        </div>
      </header>

      <div className="divide-y-2 divide-background px-1 [&>*]:first:rounded-t-xl [&>*]:last:rounded-b-xl">
        {empty ? (
          <div className="pl-4 text-xs text-muted-foreground/50">Empty</div>
        ) : (
          children
        )}
      </div>
      {footer}
    </section>
  );
}
