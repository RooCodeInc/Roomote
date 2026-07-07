import { Skeleton } from '@/components/system';

export function DiffSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}
