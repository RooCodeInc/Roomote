import type { RouterMcpServerId } from '../mcp-policy';

export const MCP_ROUTE_SUBMIT_TOOL = 'submit_routing_decision';

export function buildMcpAssistedRoutingSystemPrompt(
  baseRoutingPrompt: string,
  externalReference: string,
): string {
  const instructions = [
    `A routing precheck determined that "${externalReference}" may require external context before you finalize the routing decision.`,
    `First decide whether any available external lookup tool can actually resolve "${externalReference}".`,
    `If a relevant tool is available, use it to fetch that reference before calling ${MCP_ROUTE_SUBMIT_TOOL}.`,
    `If none of the available tools are relevant to "${externalReference}", skip the lookup and call ${MCP_ROUTE_SUBMIT_TOOL} immediately using the context you already have.`,
    'Do not speculate about other references or browse unrelated external entities.',
    `Keep needsExternalLookup set to true and externalReference set to "${externalReference}" in your final submission.`,
    `Always finish by calling ${MCP_ROUTE_SUBMIT_TOOL}.`,
  ].join(' ');

  return `${baseRoutingPrompt}\n\n${instructions}`;
}

export function buildMcpAssistedRoutingContextPrompt(
  baseContextPrompt: string,
  serverIds: readonly RouterMcpServerId[],
  externalReference: string,
): string {
  const sections = [
    baseContextPrompt.trimEnd(),
    `**External Reference To Fetch**: ${externalReference}`,
  ];

  if (serverIds.length === 0) {
    return sections.join('\n');
  }

  const lines = serverIds.map((serverId) => `- ${serverId}`);

  return [
    ...sections,
    '**Available External Lookup Services**:',
    ...lines,
  ].join('\n');
}
