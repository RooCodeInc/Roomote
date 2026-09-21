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
  'experimental.chat.messages.transform': async (_input, output) => {
    // OpenRouter replays only the first reasoning_details array it finds. Keep
    // split metadata together, and make legacy unsigned Gemini 3 tool calls
    // explicitly use Google's documented validator-bypass sentinel.
    for (const message of output.messages ?? []) {
      if (
        message.info?.role !== 'assistant' ||
        message.info.providerID !== 'openrouter' ||
        !/(^|\\/)gemini-3(?:[.-]|$)/iu.test(message.info.modelID ?? '')
      ) {
        continue;
      }

      const tool = message.parts?.find(
        (part) => part?.type === 'tool' && typeof part.callID === 'string',
      );
      if (!tool) continue;

      const details = [];
      const seen = new Set();
      for (const part of message.parts ?? []) {
        const partDetails = part?.metadata?.openrouter?.reasoning_details;
        if (!Array.isArray(partDetails)) continue;

        for (const detail of partDetails) {
          const key = JSON.stringify(detail);
          if (seen.has(key)) continue;
          seen.add(key);
          details.push(detail);
        }
      }

      if (
        !details.some(
          (detail) =>
            detail?.type === 'reasoning.encrypted' &&
            typeof detail.data === 'string' &&
            detail.data.length > 0,
        )
      ) {
        details.push({
          type: 'reasoning.encrypted',
          data: 'skip_thought_signature_validator',
          id: tool.callID,
          format: 'google-gemini-v1',
          index: 0,
        });
      }

      const target =
        message.parts.find((part) => part?.type === 'reasoning') ?? tool;
      target.metadata = {
        ...target.metadata,
        openrouter: {
          ...target.metadata?.openrouter,
          reasoning_details: details,
        },
      };
    }
  },
});
`;
