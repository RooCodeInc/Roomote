import { TRPCError } from '@trpc/server';
import {
  and,
  customAutomationTaskAccess,
  db,
  eq,
  tasks,
} from '@roomote/db/server';

export { customAutomationTaskAccess } from '@roomote/db/server';

type TaskAuth = { userId: string | null; isAdmin?: boolean };

export async function canAccessTask(auth: TaskAuth, taskId: string) {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), customAutomationTaskAccess(auth)))
    .limit(1);
  return !!task;
}

export async function requireTaskAccess(auth: TaskAuth, taskId: string) {
  if (!(await canAccessTask(auth, taskId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  }
}
