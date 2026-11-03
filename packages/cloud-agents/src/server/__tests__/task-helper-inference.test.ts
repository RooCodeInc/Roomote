import { rebaseTaskHelperInference } from '../opencode-runtime';

it.each(['openrouter', 'anthropic', 'openai', 'vllm', 'bedrock-mantle-openai'])(
  'rebases task helper %s before it can dispatch provider inference',
  (provider) => {
    const config = JSON.parse(
      rebaseTaskHelperInference(
        JSON.stringify({
          model: `${provider}/test`,
          small_model: `${provider}/test`,
          provider: {
            [provider]: {
              options: {
                apiKey: 'direct-key',
                baseURL: 'https://direct.invalid',
              },
              models: { test: { name: 'test' } },
            },
          },
        }),
        {
          R_MODEL: `${provider}/test`,
          ROOMOTE_TASK_INFERENCE_GATEWAY: 'https://api.example/api/inference',
          ROOMOTE_TASK_INFERENCE_TOKEN: 'run-token',
        },
      ),
    );
    expect(config.enabled_providers).toEqual([provider]);
    expect(config.provider[provider].options.apiKey).toBe('run-token');
    expect(config.provider[provider].options.baseURL).toContain(
      `https://api.example/api/inference/${provider}`,
    );
    expect(config.provider[provider].models.test.name).toBe('test');
  },
);

it('fails closed for an unmediated provider', () => {
  expect(() =>
    rebaseTaskHelperInference('{"model":"custom/test"}', {
      R_MODEL: 'custom/test',
      ROOMOTE_TASK_INFERENCE_GATEWAY: 'https://api.example',
      ROOMOTE_TASK_INFERENCE_TOKEN: 'token',
    }),
  ).toThrow('no admission-controlled gateway');
});

it('uses the subscription gateway for ChatGPT', () => {
  const config = JSON.parse(
    rebaseTaskHelperInference('{"model":"openai/gpt-5.4"}', {
      R_MODEL: 'openai/gpt-5.4',
      ROOMOTE_TASK_INFERENCE_GATEWAY: 'https://api.example/api/inference',
      ROOMOTE_TASK_INFERENCE_TOKEN: 'token',
      R_INFERENCE_GATEWAY_CHATGPT: '1',
    }),
  );
  expect(config.provider.openai.options.baseURL).toContain('/openai-chatgpt');
});
