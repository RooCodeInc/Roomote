import { formatInferenceCost } from '@/lib';

type SessionInferenceCostBreakdownData = {
  directInferenceCostMicroUsd: number;
  tasks: Array<{
    taskId: string;
    title: string;
    inferenceCostMicroUsd: number;
  }>;
};

export function SessionInferenceCostBreakdown({
  breakdown,
  totalInferenceCostMicroUsd,
}: {
  breakdown: SessionInferenceCostBreakdownData;
  totalInferenceCostMicroUsd: number;
}) {
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)]">
      <p className="mb-3 text-sm font-medium">Inference cost breakdown</p>
      <dl className="space-y-2 text-xs">
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted-foreground">Direct session</dt>
          <dd className="shrink-0 font-medium tabular-nums">
            ${formatInferenceCost(breakdown.directInferenceCostMicroUsd)}
          </dd>
        </div>
        {breakdown.tasks.map((task) => (
          <div
            key={task.taskId}
            className="flex items-start justify-between gap-4"
          >
            <dt className="min-w-0 break-words text-muted-foreground">
              {task.title}
            </dt>
            <dd className="shrink-0 font-medium tabular-nums">
              ${formatInferenceCost(task.inferenceCostMicroUsd)}
            </dd>
          </div>
        ))}
        <div className="flex items-start justify-between gap-4 border-t pt-2">
          <dt className="font-medium">Total</dt>
          <dd className="shrink-0 font-medium tabular-nums">
            ${formatInferenceCost(totalInferenceCostMicroUsd)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
