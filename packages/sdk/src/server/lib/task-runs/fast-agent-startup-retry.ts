import { retryFailedTaskStart } from '@roomote/cloud-agents/server';
import type { TaskRun } from '@roomote/db/server';
import type { FastAgentParent } from '@roomote/types';

export async function retryFastAgentStartup(
  run: TaskRun,
  _parent: FastAgentParent,
): Promise<
  { success: true; runId: number } | { success: false; error: string }
> {
  const result = await retryFailedTaskStart({
    sourceRun: run,
    actingUserId: run.actingUserId,
    trigger: 'fast_parent',
  });

  return result.success
    ? { success: true, runId: result.run.id }
    : { success: false, error: result.error };
}
