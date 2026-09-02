/**
 * OpenCode 1.18.10 prefixes its model-specific system prompt with its own
 * product identity. Roomote supplies the product identity in later prompt
 * layers, so remove only that prefix and preserve the remaining instructions.
 *
 * The same plugin is the single pre-execution authorization hook for Fast
 * sessions. OpenCode fires `tool.execute.before` for every tool call (native
 * bridge tools, MCP tools, and built-ins such as `task`), so one round trip to
 * the Fast tool bridge lets the Fast turn decide whether the call may start.
 * The hook is a no-op when the bridge authorization URL is not configured.
 */
export const OPENCODE_IDENTITY_PLUGIN_SCRIPT = `export const RoomoteOpenCodeIdentity = async () => ({
  'experimental.chat.system.transform': async (_input, output) => {
    if (typeof output.system?.[0] === 'string') {
      output.system[0] = output.system[0].replace(/^You are OpenCode,\\s*/iu, '');
    }
  },
  'tool.execute.before': async (input) => {
    const url = process.env.ROOMOTE_FAST_TOOL_BRIDGE_AUTHORIZE_URL;
    if (!url) return;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: \`Bearer \${process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}\`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionID: input.sessionID, tool: input.tool }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.allowed) {
      throw new Error(result?.error || 'Roomote Fast tool authorization failed.');
    }
  },
});
`;
