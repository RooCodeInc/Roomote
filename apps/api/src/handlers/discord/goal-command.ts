import { startTaskGoal } from '../tasks/startTaskGoal.js';

export async function startDiscordTaskGoal(input: {
  taskId: string;
  userId: string;
  objective: string;
  clientMessageId: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  return startTaskGoal({ ...input, source: 'discord' });
}
