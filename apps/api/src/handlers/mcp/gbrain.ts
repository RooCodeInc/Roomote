import {
  isBrainEmbeddingAvailable,
  resolveBrainConnection,
} from '@roomote/sdk/server';
import { GBRAIN_READ_TOOL_NAMES } from '@roomote/types';

import { rerankBrainQueryResult } from './gbrain-rerank';
import { createMcpProxy, McpProxyError } from './proxy-utils';

/**
 * The agent-facing Brain tool set lives in `@roomote/types` next to
 * `BRAIN_MCP_ID`, because the approval-rule compilers need the same list to
 * tell which native keys are genuinely the Brain's. Re-exported here for the
 * proxy's callers and tests.
 */
export { GBRAIN_READ_TOOL_NAMES };

/**
 * Brain proxy: fronts the deployment-hosted gbrain HTTP MCP server
 * for sandboxed agents. The upstream lives on the deployment network and is
 * never exposed publicly; sandboxes reach it only through this route with
 * their run token, and the proxy presents the read-only agent credential
 * upstream. Requests are refused unless the integration is enabled and a
 * connection (admin-entered or env-pinned) exists.
 */
export function createGbrainMcpProxy(options?: { allowAuthTokens?: boolean }) {
  return createMcpProxy({
    name: 'Brain',
    allowAuthTokens: options?.allowAuthTokens,
    allowedToolNames: GBRAIN_READ_TOOL_NAMES,
    // With a judgment model configured, `query` passages it confidently
    // judges relevant or irrelevant are moved up or down; otherwise results
    // pass through in gbrain's hybrid order.
    transformToolCallResult: rerankBrainQueryResult,
    validateTaskRunToken: async () => null,
    resolveCredentials: async () => {
      // No enablement row and no connection dialog: a deployment with a Brain
      // service has a Brain, and the read-only agent client is provisioned
      // headlessly on first use.
      //
      // Both halves are required before an agent is told the Brain exists: a
      // place to read from (connection) and a way to embed the query. Without
      // an embedding path a Brain can still answer keyword queries, which is
      // worse than absent — recall would look real while silently missing
      // everything semantic. The embedding check is provider-agnostic, matching
      // the ingest side (isBrainEmbeddingAvailable): a self-run embedder is
      // enough, so a trial or Anthropic-only tenant whose pages the drain
      // ingested can also query them, instead of accumulating unreadable memory.
      const [connection, embeddingAvailable] = await Promise.all([
        resolveBrainConnection('agent'),
        isBrainEmbeddingAvailable(),
      ]);

      if (!connection || !embeddingAvailable) {
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
