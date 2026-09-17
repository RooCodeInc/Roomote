import {
  and,
  customAutomationFastSessionAccess,
  customAutomationSessionAccess,
  customAutomationTaskAccess,
  or,
  privateFastSessionAccess,
  privateSessionAccess,
  privateTaskAccess,
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
  const user = { userId: auth.userId ?? '', isAdmin: false };
  const privateAccess =
    kind === 'task'
      ? privateTaskAccess(user)
      : kind === 'session'
        ? privateSessionAccess(user)
        : privateFastSessionAccess(user);
  if (
    auth.authContext.tokenType === 'run' &&
    auth.authContext.principal === 'deployment' &&
    auth.authContext.userId === null
  )
    return privateAccess;
  const access =
    kind === 'task'
      ? customAutomationTaskAccess(user)
      : kind === 'session'
        ? customAutomationSessionAccess(user)
        : customAutomationFastSessionAccess(user);
  return and(
    privateAccess,
    or(
      sql`exists (select 1 from ${users} history_user
      where history_user.id = ${user.userId}
        and history_user.role = 'admin'
        and history_user.deleted_at is null)`,
      access,
    ),
  );
}
