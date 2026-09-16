import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';

const IOS_APP_MCP_ID = 'ios_app';

/**
 * Whether the deployment has an APNs key on file, so the app knows to
 * register for push. The key itself is only read by the push sender.
 */
export async function getIosAppPushConfigured(): Promise<boolean> {
  const [row] = await db
    .select({ id: mcpConnections.id, enabled: mcpConnections.enabled })
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.mcpId, IOS_APP_MCP_ID),
        isNull(mcpConnections.userId),
        eq(mcpConnections.connectionRole, 'default'),
      ),
    )
    .limit(1);
  return Boolean(row?.enabled);
}
