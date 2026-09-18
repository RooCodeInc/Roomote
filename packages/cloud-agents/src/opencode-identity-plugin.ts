/**
 * OpenCode 1.18.30 opens its model-specific system prompt with its own
 * product identity: most prompts start "You are OpenCode, ...", and the GPT-6
 * prompt starts with a full sentence naming OpenCode as the harness. Roomote
 * supplies the product identity in later prompt layers, so remove only that
 * leading declaration and preserve the remaining instructions.
 */
export const OPENCODE_IDENTITY_PLUGIN_SCRIPT = `export const RoomoteOpenCodeIdentity = async () => ({
  'experimental.chat.system.transform': async (_input, output) => {
    if (typeof output.system?.[0] === 'string') {
      output.system[0] = output.system[0]
        .replace(/^You are an AI agent powered by OpenCode, a coding agent harness\\.\\s*/iu, '')
        .replace(/^You are OpenCode,\\s*/iu, '');
    }
  },
});
`;
