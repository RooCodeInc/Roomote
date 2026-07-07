import type { UserAuthSuccess } from '@/types';
import { getTaskMessageEnvelopes } from '@/lib/server';

export async function getTaskMessageEnvelopesCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  return getTaskMessageEnvelopes({
    taskId: input.taskId,
    userId: auth.userId,
  });
}
