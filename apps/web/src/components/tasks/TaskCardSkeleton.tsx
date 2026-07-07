import { Skeleton } from '@/components/system';

interface TaskCardSkeletonProps {
  count?: number;
}

export function TaskCardSkeleton({ count = 6 }: TaskCardSkeletonProps) {
  const titleWidths = ['50%', '45%', '40%', '35%'] as const;

  return (
    <div className="w-full divide-y divide-card">
      {Array.from({ length: count }).map((_, i) => {
        const titleWidth = titleWidths[i % titleWidths.length];

        return (
          <div key={i} className="relative flex items-start gap-3 w-full p-4">
            {/* Avatar */}
            <div className="relative mt-1 shrink-0 h-8 w-12 flex justify-center">
              <div className="flex items-center -space-x-2.5">
                <Skeleton className="size-8 rounded-full" />
              </div>
            </div>

            {/* Content */}
            <div className="flex flex-col min-w-0 flex-1">
              {/* Byline + timestamp */}
              <div className="flex items-start md:items-center gap-2 justify-between">
                <div className="flex items-center gap-1 flex-wrap">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-3 w-20 shrink-0" />
              </div>

              {/* Title */}
              <div className="mt-1 mb-2 max-w-xl space-y-1.5">
                <Skeleton className="h-5" style={{ width: titleWidth }} />
              </div>

              {/* Metadata badges */}
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
