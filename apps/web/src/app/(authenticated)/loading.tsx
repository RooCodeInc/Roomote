import { Skeleton } from '@/components/system';

export default function AuthenticatedRouteLoading() {
  return (
    <div
      className="min-h-full w-full overflow-hidden bg-background p-8"
      role="status"
      aria-label="Loading page"
    >
      <div className="w-full max-w-6xl space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>

        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      </div>
      <span className="sr-only">Loading page</span>
    </div>
  );
}
