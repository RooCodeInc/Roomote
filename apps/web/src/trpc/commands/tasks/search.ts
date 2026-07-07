import type { UserAuthSuccess } from '@/types';
import { searchTasks } from '@/lib/server';

export async function searchTasksCommand(
  auth: UserAuthSuccess,
  input: { query?: string; limit?: number; includeIds?: string[] },
) {
  return searchTasks({
    userId: auth.userId,
    query: input.query,
    limit: input.limit,
    includeIds: input.includeIds,
  });
}
