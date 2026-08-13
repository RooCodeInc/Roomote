'use client';

import { Skeleton } from '@/components/system';
import { FramedSurface } from '@/components/layout';

export function TaskWorkspaceSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading task workspace"
      className="flex h-full min-h-0 min-w-0 flex-1 bg-card"
    >
      <FramedSurface
        frameClassName="pb-0 md:pb-2"
        surfaceClassName="flex flex-col bg-transparent @container"
      >
        <div className="flex shrink-0 items-center border-b-2 border-card px-4 py-3">
          <Skeleton className="mx-auto h-5 w-48 max-w-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col rounded-r-3xl bg-background">
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-4">
            <div className="ml-auto w-3/4 space-y-2">
              <Skeleton className="ml-auto h-4 w-24" />
              <Skeleton className="ml-auto h-16 w-full rounded-2xl" />
            </div>
            <div className="w-4/5 space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
          </div>
          <div className="border-2 border-background bg-card p-4">
            <Skeleton className="mx-auto h-10 w-full max-w-4xl rounded-xl" />
          </div>
        </div>
      </FramedSurface>
    </div>
  );
}
