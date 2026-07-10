import { getTaskMessageEnvelopes } from '@/lib/server';

export async function getTaskMessageEnvelopesCommand(input: {
  taskId: string;
}) {
  return getTaskMessageEnvelopes({
    taskId: input.taskId,
  });
}
