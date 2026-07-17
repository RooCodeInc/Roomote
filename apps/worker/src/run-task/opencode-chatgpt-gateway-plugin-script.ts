import { INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME } from '@roomote/types';

/**
 * OpenCode's built-in Codex plugin applies this model filter and metadata only
 * when the local auth record has type `oauth`. ChatGPT gateway mode deliberately
 * keeps that record off the sandbox, so this generated plugin restores the same
 * provider-model behavior without restoring the credential or the Codex fetch
 * hook that would bypass Roomote's gateway.
 *
 * Keep this in sync with the Codex plugin bundled by
 * DEFAULT_OPENCODE_CLI_VERSION (`packages/opencode/src/plugin/openai/codex.ts`).
 */
export const OPENCODE_CHATGPT_GATEWAY_PLUGIN_SCRIPT = String.raw`
const CHATGPT_GATEWAY_ENV_VAR = ${JSON.stringify(INFERENCE_GATEWAY_CHATGPT_ENV_VAR_NAME)};
const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
]);
const DISALLOWED_MODELS = new Set(['gpt-5.5-pro']);

function isSubscriptionModel(model) {
  if (model.options.reasoningMode === 'pro') return false;
  if (ALLOWED_MODELS.has(model.api.id)) return true;
  if (DISALLOWED_MODELS.has(model.api.id)) return false;
  if (model.api.id === 'gpt-5.6') return false;

  const match = model.api.id.match(/^gpt-(\d+\.\d+)/);
  return match ? Number.parseFloat(match[1]) > 5.4 : false;
}

function asSubscriptionModel(model) {
  return {
    ...model,
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: model.id.includes('gpt-5.5')
      ? {
          context: 400_000,
          input: 272_000,
          output: 128_000,
        }
      : model.id.includes('gpt-5.6')
        ? {
            context: 500_000,
            input: 372_000,
            output: 128_000,
          }
        : model.limit,
  };
}

export const RoomoteChatGptGatewayModels = async () => ({
  provider: {
    id: 'openai',
    async models(provider) {
      if (process.env[CHATGPT_GATEWAY_ENV_VAR] !== '1') {
        return provider.models;
      }

      return Object.fromEntries(
        Object.entries(provider.models)
          .filter(([, model]) => isSubscriptionModel(model))
          .map(([modelId, model]) => [modelId, asSubscriptionModel(model)]),
      );
    },
  },
});
`;
