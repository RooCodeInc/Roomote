import { getTaskUrl } from '@roomote/cloud-agents/server';

export function getSlackStartedMessageFollowUrl({
  taskId,
}: {
  taskId?: string | null;
}): string | undefined {
  if (taskId) {
    return getTaskUrl({
      taskId,
      utm: { source: 'slack', campaign: 'follow_task' },
    });
  }

  return undefined;
}
