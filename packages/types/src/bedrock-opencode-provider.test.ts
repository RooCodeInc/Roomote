import { mergeBedrockProviderConfigs } from './bedrock-opencode-provider';

describe('mergeBedrockProviderConfigs', () => {
  it('registers each transport while preserving its option precedence', () => {
    const providerConfig = mergeBedrockProviderConfigs(
      {
        'bedrock-mantle': {
          options: {
            apiKey: 'existing-mantle-key',
            baseURL: 'https://existing-mantle.example.com',
            custom: true,
          },
          models: {
            'anthropic.claude-sonnet-5': { name: 'Existing Claude name' },
          },
        },
        'bedrock-mantle-openai': {
          options: {
            apiKey: 'existing-openai-key',
            baseURL: 'https://existing-openai.example.com',
          },
        },
        'amazon-bedrock': {
          options: { apiKey: 'existing-native-key', custom: true },
        },
      },
      { AWS_REGION: 'eu-west-1' },
      [
        'bedrock-mantle/anthropic.claude-sonnet-5',
        'bedrock-mantle-openai/openai.gpt-5.6-luna',
        'amazon-bedrock/amazon.nova-2-lite-v1:0',
      ],
    );

    expect(providerConfig).toMatchObject({
      'bedrock-mantle': {
        npm: '@ai-sdk/anthropic',
        options: {
          apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
          baseURL: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1',
          custom: true,
        },
        models: {
          'anthropic.claude-sonnet-5': { name: 'Existing Claude name' },
        },
      },
      'bedrock-mantle-openai': {
        npm: '@ai-sdk/openai',
        options: {
          apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
          baseURL: 'https://bedrock-mantle.eu-west-1.api.aws/openai/v1',
        },
        models: {
          'openai.gpt-5.6-luna': { name: 'openai.gpt-5.6-luna' },
        },
      },
      'amazon-bedrock': {
        npm: '@ai-sdk/amazon-bedrock',
        options: { apiKey: 'existing-native-key', custom: true },
        models: {
          'amazon.nova-2-lite-v1:0': {
            name: 'amazon.nova-2-lite-v1:0',
          },
        },
      },
    });
  });
});
