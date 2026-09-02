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
});
`;
