/**
 * OpenCode 1.18.10 prefixes its model-specific system prompt with its own
 * product identity. Roomote supplies the product identity in later prompt
 * layers, so remove only that prefix and preserve the remaining instructions.
 */
export const OPENCODE_IDENTITY_PLUGIN_SCRIPT = `export const RoomoteOpenCodeIdentity = async () => ({
  'experimental.chat.system.transform': async (_input, output) => {
    if (typeof output.system?.[0] === 'string') {
      output.system[0] = output.system[0].replace(/^You are OpenCode,\\s*/iu, '');
    }
  },
  'tool.execute.before': async (input) => {
    if (input.tool !== 'task' || !process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL) return;
    const response = await fetch(
      process.env.ROOMOTE_FAST_TOOL_BRIDGE_URL.replace(/\\/tool$/u, '/authorize-substantive-tool'),
      {
        method: 'POST',
        headers: {
          authorization: \`Bearer \${process.env.ROOMOTE_FAST_TOOL_BRIDGE_TOKEN}\`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionID: input.sessionID, tool: input.tool }),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.allowed) {
      throw new Error(result.error || 'A text acknowledgement is required before this action.');
    }
  },
});
`;
