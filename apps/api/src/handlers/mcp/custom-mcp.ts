import { Env } from '@roomote/env';
import { and, db, eq, mcpConnections } from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import {
  customMcpConnectionWhere,
  findCustomMcpServerById,
  getValidAccessToken,
} from '@roomote/sdk/server';

import {
  createMcpProxy,
  McpProxyError,
  resolveActingUserId,
} from './proxy-utils';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Untrusted custom upstreams get a request-body cap; curated servers have no
 * cap because their upstreams are known parties.
 */
const MAX_CUSTOM_MCP_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Proxy for custom MCP servers, deployment and personal, at
 * `/api/mcp/custom/:serverId`.
 *
 * The upstream URL and credentials resolve per request from the
 * `custom_mcp_servers` row, so Settings edits apply to in-flight tasks
 * without re-delivery. Upstream egress is SSRF-guarded (private ranges
 * blocked unless allowed via R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS, DNS answers
 * pinned, redirects refused) because the upstream is operator-controlled.
 *
 * A deployment server's credentials do not depend on the acting user. A
 * personal server's do: only its owner may reach it, checked here on every
 * request against the human the call is acting for, and anyone else gets the
 * same 404 as a server that does not exist.
 */
export function createCustomMcpProxy() {
  return createMcpProxy({
    name: 'Custom',
    allowAuthTokens: true,
    guardUpstreamEgress: {
      allowedPrivateCidrs: Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
    },
    maxRequestBodyBytes: MAX_CUSTOM_MCP_REQUEST_BODY_BYTES,
    resolveCredentials: async (auth, routeParams) => {
      const serverId = routeParams['serverId'];

      if (!serverId || !UUID_PATTERN.test(serverId)) {
        throw new McpProxyError(404, 'Custom MCP server not found');
      }

      const server = await findCustomMcpServerById(serverId);

      if (!server || !server.enabled || !server.url || server.isStdio) {
        throw new McpProxyError(404, 'Custom MCP server not found');
      }

      if (
        server.ownerUserId &&
        (await resolveActingUserId(auth)) !== server.ownerUserId
      ) {
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
            customMcpConnectionWhere(server),
            eq(mcpConnections.enabled, true),
          ),
          columns: { id: true },
        });

        const accessToken = connection
          ? await getValidAccessToken(connection.id, server.url)
          : null;

        if (!accessToken) {
          throw new McpProxyError(
            401,
            server.ownerUserId
              ? `Custom MCP server '${server.name}' needs to be reconnected in Personal settings`
              : `Custom MCP server '${server.name}' needs to be reconnected by a deployment admin in Settings > Integrations`,
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
