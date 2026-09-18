import { getTaskMessageEnvelopePage } from '@/lib/server';
import type { TaskMessageEnvelopeCursor, UserAuthSuccess } from '@/types';
import { requireTaskReadAccess } from '@/lib/server/custom-automation-task-access';

export async function getTaskMessageEnvelopesCommand(
  auth: UserAuthSuccess,
  input: {
    taskId: string;
    cursor?: TaskMessageEnvelopeCursor;
  },
) {
  await requireTaskReadAccess(auth, input.taskId);
  return getTaskMessageEnvelopePage({
    taskId: input.taskId,
    cursor: input.cursor,
  });
}
