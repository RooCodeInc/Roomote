import type { ReactNode } from 'react';

import { RoomoteWordmark } from './RoomoteWordmark';

export function PreSessionBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="light relative min-h-effective-viewport w-full overflow-hidden bg-accent-bright-foreground text-foreground">
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none absolute -inset-6 flex select-none bg-card opacity-70 blur-[5px] saturate-125"
        data-slot="pre-session-product-preview"
      >
        <aside className="hidden w-64 shrink-0 flex-col gap-6 bg-card p-6 md:flex">
          <RoomoteWordmark className="h-8 w-fit" />
          <div className="space-y-2">
            <div className="h-10 rounded-full bg-foreground/10" />
            <div className="h-10 rounded-full bg-accent-foreground/45" />
            <div className="h-10 rounded-full bg-foreground/10" />
            <div className="h-10 rounded-full bg-foreground/10" />
          </div>
          <div className="mt-auto space-y-3">
            <div className="h-3 w-3/5 rounded-full bg-foreground/15" />
            <div className="h-3 w-4/5 rounded-full bg-foreground/10" />
            <div className="h-10 rounded-full bg-foreground/10" />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col p-4 md:p-8">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-background shadow-xl">
            <div className="flex h-20 items-center gap-4 border-b-4 border-card bg-background px-6">
              <div className="h-9 w-36 rounded-full bg-card" />
              <div className="h-9 w-28 rounded-full bg-card" />
              <div className="ml-auto size-9 rounded-full bg-card" />
            </div>
            <div className="grid flex-1 gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="flex min-h-36 flex-col rounded-2xl bg-card p-5 shadow-sm"
                >
                  <div className="mb-5 h-4 w-2/3 rounded-full bg-foreground/15" />
                  <div className="mb-2 h-3 w-full rounded-full bg-foreground/10" />
                  <div className="h-3 w-4/5 rounded-full bg-foreground/10" />
                  <div className="mt-auto h-7 w-20 rounded-full bg-accent-foreground/50" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-accent-bright-foreground/45" />
      <div className="relative z-base flex min-h-effective-viewport w-full items-center justify-center">
        {children}
      </div>
    </div>
  );
}
