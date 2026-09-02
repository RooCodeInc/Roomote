/**
 * Shared matching for the on-demand integration tool lookup that Fast
 * (`find_integration_tools`) and task sandboxes (`roomote_find_integration_tools`)
 * both expose. Each runtime gathers its catalog its own way; the selection,
 * ranking, and bounding of results are the same on both sides.
 */

export type IntegrationToolCandidate = {
  integrationId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type IntegrationToolLookupParams = {
  integrationId?: string;
  toolName?: string;
  query?: string;
  limit?: number;
};

export const INTEGRATION_TOOL_LOOKUP_DEFAULT_LIMIT = 10;
export const INTEGRATION_TOOL_LOOKUP_MAX_LIMIT = 25;
export const INTEGRATION_TOOL_LOOKUP_TRUNCATED_GUIDANCE =
  'More tools matched than were returned. Narrow the query or pass integrationId or toolName.';

/**
 * Select tools for a lookup. An exact tool name wins; otherwise every query
 * term must appear in the tool's name or description, with tools whose name
 * equals a term ranked first. Results are bounded by `limit`.
 */
export function matchIntegrationTools(
  candidates: IntegrationToolCandidate[],
  params: IntegrationToolLookupParams,
): { tools: IntegrationToolCandidate[]; truncated: boolean } {
  const limit = params.limit ?? INTEGRATION_TOOL_LOOKUP_DEFAULT_LIMIT;
  const terms = (params.query ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  const matches: Array<{ tool: IntegrationToolCandidate; exact: boolean }> = [];
  for (const tool of candidates) {
    if (params.integrationId && tool.integrationId !== params.integrationId) {
      continue;
    }
    if (params.toolName && tool.name !== params.toolName) continue;
    const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) {
      continue;
    }
    matches.push({
      tool,
      exact:
        Boolean(params.toolName) ||
        terms.some((term) => tool.name.toLowerCase() === term),
    });
  }
  matches.sort((left, right) => Number(right.exact) - Number(left.exact));
  return {
    tools: matches.slice(0, limit).map(({ tool }) => tool),
    truncated: matches.length > limit,
  };
}
