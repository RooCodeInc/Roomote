import {
  resolveBrainInferenceProvider,
  resolveBrainConnection,
} from '@roomote/sdk/server';

import { createMcpProxy, McpProxyError } from './proxy-utils';

/**
 * Read-only tool allowlist over gbrain's MCP surface, which publishes over a
 * hundred tools. The list is filtered on `tools/list` as well as on calls, so
 * an agent sees only these and never has to choose against the rest.
 *
 * `remember` and `forget` are deliberately absent: the agent path is
 * structurally incapable of mutation, and memory writes flow only through
 * the server-side ingestion pipeline with its own write-only credential.
 *
 * Deliberately absent for a second reason, that nothing here populates what
 * they read:
 * - `recall` leads with hot-memory facts saved via `remember`, which this
 *   deployment never writes. Its page arm duplicates `search`, so exposing it
 *   only offers a worse `search` with a permanently empty half.
 * - `context_pack` and `delta` serve long-lived agents with standing entities
 *   and heartbeats. Roomote's agents are per-task and start cold.
 *
 * Keep this list in sync with the instructions in @roomote/types: a tool
 * exposed but unexplained is one the agent picks by gbrain's own description,
 * which is written for a different product.
 */
export const GBRAIN_READ_TOOL_NAMES = [
  // Ask. `query` adds multi-query expansion and is the right default when the
  // agent does not know the corpus vocabulary; `search` is the cheaper exact
  // -token path with no expansion call.
  'query',
  'search',
  // Exact, zero-LLM lookup for canonical person cards populated from Roomote
  // member identities. Prefer this over broad search for a known person.
  'entity',
  // Reason across pages. Expensive and slow, but bounded in tokens, which is
  // the only reason to prefer it over reading pages directly.
  'synthesize',
  // Browse: without these an agent can only answer questions it already
  // knows to ask, and "what do you know?" looks like an empty Brain.
  'list_pages',
  'get_page',
] as const;

/**
 * Brain proxy: fronts the deployment-hosted gbrain HTTP MCP server
 * for sandboxed agents. The upstream lives on the deployment network and is
 * never exposed publicly; sandboxes reach it only through this route with
 * their run token, and the proxy presents the read-only agent credential
 * upstream. Requests are refused unless the integration is enabled and a
 * connection (admin-entered or env-pinned) exists.
 */
export function createGbrainMcpProxy() {
  return createMcpProxy({
    name: 'Brain',
    allowedToolNames: GBRAIN_READ_TOOL_NAMES,
    validateTaskRunToken: async () => null,
    resolveCredentials: async () => {
      // No enablement row and no connection dialog: a deployment with a Brain
      // service has a Brain, and the read-only agent client is provisioned
      // headlessly on first use.
      //
      // Both halves are required before an agent is told the Brain exists. A
      // Brain container with no provider key configured yet can still answer
      // keyword queries, which is worse than absent: recall would look real
      // while silently missing everything semantic.
      const [connection, provider] = await Promise.all([
        resolveBrainConnection('agent'),
        resolveBrainInferenceProvider(),
      ]);

      if (!connection || !provider) {
        throw new McpProxyError(
          404,
          'The Brain is not configured on this deployment',
        );
      }

      return {
        authHeader: connection.token,
        upstream: `${connection.baseUrl.replace(/\/$/, '')}/mcp`,
      };
    },
  });
}
