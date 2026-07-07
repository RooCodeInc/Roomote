import type { McpAuth } from '../mcp/middleware';

import { db, eq, users } from '@roomote/db/server';

/**
 * Resolve the caller's org membership role (e.g. `org:admin`, `org:member`),
 * or `null` when the token has no user or no membership in the org.
 *
 * Kept in its own module (rather than the broader `./helpers`) so admin-gating
 * callers pull in only the membership query — no transitive task/table imports.
 * Shared by handlers that gate admin-only behavior such as admin-required task
 * launches and inference-cost visibility.
 */
export async function getMembershipRole(auth: McpAuth): Promise<string | null> {
  if (!auth.userId) {
    return null;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { role: true, deletedAt: true },
  });

  if (!user || user.deletedAt != null) {
    return null;
  }

  return user.role === 'admin' ? 'org:admin' : 'org:member';
}
