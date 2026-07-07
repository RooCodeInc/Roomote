import {
  getAllowedIntegrationMcpToolNames,
  type McpIntegration,
} from '@roomote/types';
export { GRAFANA_READ_ONLY_TOOL_NAMES } from '@roomote/types';

export function getIntegrationMcpProxyOptions(
  integration: McpIntegration,
): { allowedToolNames: readonly string[] } | undefined {
  const allowedToolNames = getAllowedIntegrationMcpToolNames(integration);

  if (!allowedToolNames) {
    return undefined;
  }

  return { allowedToolNames };
}
