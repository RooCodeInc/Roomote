import { describe, expect, it } from 'vitest';

import { getSetupModelProvider } from '@roomote/types';

import { getProviderSaveFeedback } from './provider-save-feedback';

const bedrock = getSetupModelProvider('amazon-bedrock');
const counts = { addedRecommendedModelCount: 0, addedDiscoveredModelCount: 0 };

describe('getProviderSaveFeedback', () => {
  it('asks for a model after connecting a provider that enables none', () => {
    expect(
      getProviderSaveFeedback({
        provider: bedrock,
        providerLabel: 'Amazon Bedrock',
        ...counts,
        models: [
          { id: 'openrouter/anthropic/claude-sonnet-5', enabled: true },
          { id: 'bedrock-mantle/anthropic.claude-sonnet-5', enabled: false },
        ],
      }),
    ).toEqual({
      message:
        'Saved the Amazon Bedrock API key. Enable a model below to start using it.',
      showModelList: true,
    });
  });

  it('stays quiet when a provider model is already enabled or the list is unknown', () => {
    const quiet = {
      message: 'Saved the Amazon Bedrock API key.',
      showModelList: false,
    };

    expect(
      getProviderSaveFeedback({
        provider: bedrock,
        providerLabel: 'Amazon Bedrock',
        ...counts,
        models: [{ id: 'amazon-bedrock/zai.glm-5', enabled: true }],
      }),
    ).toEqual(quiet);
    expect(
      getProviderSaveFeedback({
        provider: bedrock,
        providerLabel: 'Amazon Bedrock',
        ...counts,
        models: undefined,
      }),
    ).toEqual(quiet);
  });

  it('keeps the added-model messages for providers that seed models', () => {
    expect(
      getProviderSaveFeedback({
        provider: getSetupModelProvider('anthropic'),
        providerLabel: 'Anthropic',
        addedRecommendedModelCount: 3,
        addedDiscoveredModelCount: 0,
        models: [],
      }),
    ).toEqual({
      message: 'Saved the Anthropic API key and added 3 recommended models.',
      showModelList: true,
    });
    expect(
      getProviderSaveFeedback({
        provider: getSetupModelProvider('ollama'),
        providerLabel: 'Ollama',
        addedRecommendedModelCount: 0,
        addedDiscoveredModelCount: 1,
        models: [],
      }),
    ).toEqual({
      message:
        'Saved the Ollama API key and made 1 discovered model available.',
      showModelList: true,
    });
  });
});
