import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { BRAIN_MCP_ID, isMcpConnectionGbrainConfig } from '@roomote/types';
import { Env } from '@/lib/server/env';

/**
 * Whether Roomote holds usable Brain credentials, read without minting or
 * provisioning anything. Deliberately not `resolveBrainConnection`: the
 * corpus read already takes that path once per request.
 */
export async function hasBrainCredentials(): Promise<boolean> {
  if (Env.R_GBRAIN_AGENT_TOKEN) {
    return true;
  }

  const stored = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, BRAIN_MCP_ID),
      isNull(mcpConnections.userId),
    ),
  });

  return isMcpConnectionGbrainConfig(stored?.authConfig);
}
