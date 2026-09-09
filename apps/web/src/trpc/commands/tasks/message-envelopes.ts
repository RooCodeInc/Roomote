import { getTaskMessageEnvelopes } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import { requireTaskReadAccess } from '@/lib/server/custom-automation-task-access';

export async function getTaskMessageEnvelopesCommand(
  auth: UserAuthSuccess,
  input: {
    taskId: string;
  },
) {
  await requireTaskReadAccess(auth, input.taskId);
  return getTaskMessageEnvelopes({
    taskId: input.taskId,
  });
}
