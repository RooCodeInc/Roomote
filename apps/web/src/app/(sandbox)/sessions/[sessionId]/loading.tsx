import { Skeleton } from '@/components/system';

export default function LoadingSession() {
  return (
    <div
      role="status"
      aria-label="Loading session"
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-r-3xl bg-background"
    >
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 @[600px]:px-6">
        <Skeleton className="h-5 w-64 max-w-2/3" />
        <Skeleton className="ml-auto size-8 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-5 px-4 py-6 @[600px]:px-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    </div>
  );
}
