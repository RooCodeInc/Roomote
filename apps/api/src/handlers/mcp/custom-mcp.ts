import { Env } from '@roomote/env';
import {
  and,
  db,
  eq,
  customMcpServers,
  isNull,
  mcpConnections,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { getValidAccessToken } from '@roomote/sdk/server';
import { customMcpConnectionId } from '@roomote/types';

import { createMcpProxy, McpProxyError } from './proxy-utils';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Untrusted custom upstreams get a request-body cap; curated servers have no
 * cap because their upstreams are known parties.
 */
const MAX_CUSTOM_MCP_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Proxy for deployment-scoped custom MCP servers at
 * `/api/mcp/custom/:serverId`.
 *
 * The upstream URL and credentials resolve per request from the
 * `custom_mcp_servers` row, so Settings edits apply to in-flight tasks
 * without re-delivery. Upstream egress is SSRF-guarded (private ranges
 * blocked unless allowed via R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS, DNS answers
 * pinned, redirects refused) because the upstream is operator-controlled.
 *
 * Custom-server connections are deployment-scoped: credential selection does
 * not depend on the acting user, so no acting-user resolution happens here.
 */
export function createCustomMcpProxy() {
  return createMcpProxy({
    name: 'Custom',
    guardUpstreamEgress: {
      allowedPrivateCidrs: Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
    },
    maxRequestBodyBytes: MAX_CUSTOM_MCP_REQUEST_BODY_BYTES,
    resolveCredentials: async (_auth, routeParams) => {
      const serverId = routeParams['serverId'];

      if (!serverId || !UUID_PATTERN.test(serverId)) {
        throw new McpProxyError(404, 'Custom MCP server not found');
      }

      const server = await db.query.customMcpServers.findFirst({
        where: and(
          eq(customMcpServers.id, serverId),
          eq(customMcpServers.enabled, true),
        ),
      });

      if (!server || !server.url || server.stdio) {
        throw new McpProxyError(404, 'Custom MCP server not found');
      }

      let authHeader: string | null = null;
      let extraHeaders: Record<string, string> | undefined;

      if (server.authType === 'static_headers' && server.headers) {
        extraHeaders = {};

        for (const [headerName, encryptedValue] of Object.entries(
          server.headers,
        )) {
          extraHeaders[headerName] = decrypt(encryptedValue);
        }
      } else if (server.authType === 'oauth') {
        const connection = await db.query.mcpConnections.findFirst({
          where: and(
            eq(mcpConnections.mcpId, customMcpConnectionId(server.id)),
            eq(mcpConnections.enabled, true),
            isNull(mcpConnections.userId),
          ),
          columns: { id: true },
        });

        const accessToken = connection
          ? await getValidAccessToken(connection.id, server.url)
          : null;

        if (!accessToken) {
          throw new McpProxyError(
            401,
            `Custom MCP server '${server.name}' needs to be reconnected by a deployment admin in Settings > Integrations`,
          );
        }

        authHeader = accessToken;
      }

      return {
        authHeader,
        extraHeaders,
        disabledToolNames: server.disabledTools,
        upstream: server.url,
      };
    },
  });
}
