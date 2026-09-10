import {
  customAutomationFastSessionAccess,
  customAutomationSessionAccess,
  customAutomationTaskAccess,
  or,
  sql,
  users,
} from '@roomote/db/server';
import type { McpAuth } from './mcp/middleware';

// Only userless deployment-principal runs retain trusted history access.
// Human auth and run tokens use the persisted role in the same query.
export function customAutomationHistoryAccess(
  auth: McpAuth,
  kind: 'task' | 'session' | 'fast',
) {
  if (
    auth.authContext.tokenType === 'run' &&
    auth.authContext.principal === 'deployment' &&
    auth.authContext.userId === null
  )
    return undefined;
  const user = { userId: auth.userId ?? '', isAdmin: false };
  const access =
    kind === 'task'
      ? customAutomationTaskAccess(user)
      : kind === 'session'
        ? customAutomationSessionAccess(user)
        : customAutomationFastSessionAccess(user);
  return or(
    sql`exists (select 1 from ${users} history_user
      where history_user.id = ${user.userId}
        and history_user.role = 'admin'
        and history_user.deleted_at is null)`,
    access,
  );
}
