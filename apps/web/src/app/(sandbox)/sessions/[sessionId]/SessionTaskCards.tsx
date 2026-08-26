'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

export type SessionTaskSummary = {
  taskId: string;
  title: string;
  workflow: string;
  state: string;
  repositoryName: string | null;
  latestOutput: string | null;
  inferenceCostMicroUsd: number;
  canAccessDetails?: boolean;
  latestRun: {
    id: number;
    status: string;
    taskPhase: string | null;
    error: string | null;
    result: unknown;
  } | null;
  artifacts: Array<{
    id: string;
    path: string;
    artifactType: string;
  }>;
  pullRequests: Array<{
    id: string;
    url: string;
    number: number | null;
    title: string | null;
    repository: string | null;
    status: string | null;
  }>;
};

export function SessionTaskCards({
  sessionId,
  tasks,
}: {
  sessionId: string;
  tasks: SessionTaskSummary[];
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const cancel = useMutation(trpc.taskRuns.cancel.mutationOptions());
  const retry = useMutation(trpc.taskRuns.retryFailedStart.mutationOptions());

  if (tasks.length === 0) return null;

  const selectTask = (taskId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('task', taskId);
    router.replace(`/sessions/${sessionId}?${params.toString()}`);
  };

  return (
    <section aria-labelledby="session-executions" className="space-y-2 py-3">
      <h2 id="session-executions" className="text-sm font-medium">
        Executions
      </h2>
      <div className="grid gap-2 md:grid-cols-2">
        {tasks.map((task) => (
          <Card key={task.taskId} className="gap-2">
            <CardHeader className="gap-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="line-clamp-2 text-sm">
                  {task.title}
                </CardTitle>
                <Badge
                  variant={
                    task.state === 'failed'
                      ? 'destructive'
                      : task.state === 'active'
                        ? 'success'
                        : 'secondary'
                  }
                >
                  {task.state}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              <p>{task.repositoryName ?? task.workflow}</p>
              {task.latestRun?.error ? (
                <p className="line-clamp-2 text-destructive">
                  {task.latestRun.error}
                </p>
              ) : null}
              {task.latestOutput ? (
                <p className="line-clamp-2">{task.latestOutput}</p>
              ) : null}
              <p>
                ${(task.inferenceCostMicroUsd / 1_000_000).toFixed(4)} inference
              </p>
              {task.canAccessDetails === false ? (
                <p>Execution details require task access.</p>
              ) : null}
            </CardContent>
            <CardFooter align="end">
              {task.canAccessDetails === false ? null : task.state ===
                'active' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const result = await cancel.mutateAsync({
                      taskId: task.taskId,
                      runId: task.latestRun?.id,
                    });
                    if (!result.success) toast.error(result.error);
                  }}
                >
                  Stop
                </Button>
              ) : task.state === 'failed' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const result = await retry.mutateAsync({
                      taskId: task.taskId,
                      runId: task.latestRun?.id,
                    });
                    if (!result.success) toast.error(result.error);
                  }}
                >
                  Retry
                </Button>
              ) : null}
              {task.canAccessDetails === false ? null : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => selectTask(task.taskId)}
                  >
                    Details
                  </Button>
                  <Button size="sm" asChild>
                    <Link
                      href={`/task/${task.taskId}?returnTo=${encodeURIComponent(`/sessions/${sessionId}?task=${task.taskId}`)}`}
                    >
                      Open workspace
                    </Link>
                  </Button>
                </>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}
