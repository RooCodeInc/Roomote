import { getTaskMessageEnvelopes } from '@/lib/server';
import type { UserAuthSuccess } from '@/types';
import { requireTaskAccess } from '@/lib/server/custom-automation-task-access';

export async function getTaskMessageEnvelopesCommand(
  auth: UserAuthSuccess,
  input: {
    taskId: string;
  },
) {
  await requireTaskAccess(auth, input.taskId);
  return getTaskMessageEnvelopes({
    taskId: input.taskId,
  });
}
