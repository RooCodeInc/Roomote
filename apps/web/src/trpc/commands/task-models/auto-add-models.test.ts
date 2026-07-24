import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MODEL_ID,
  getSetupModelProvider,
  getTaskModelProviderId,
} from '@roomote/types';

import {
  appendRecommendedTaskModels,
  appendSelectedTaskModels,
  buildAutoAddedTaskModelSettings,
  collectConnectedTaskModelProviderIds,
} from './auto-add-models';

const ANTHROPIC = getSetupModelProvider('anthropic');
const OPENROUTER = getSetupModelProvider('openrouter');
const GOOGLE = getSetupModelProvider('google');

describe('buildAutoAddedTaskModelSettings', () => {
  it('seeds a fresh deployment with only the connected provider models', () => {
    const result = buildAutoAddedTaskModelSettings({
      provider: ANTHROPIC,
      persistedTaskModelSettings: null,
      connectedProviderIds: new Set(['anthropic']),
    });

    expect(result).not.toBeNull();
    expect(result!.taskModelSettings.models?.length).toBeGreaterThan(0);
    expect(
      result!.taskModelSettings.models?.every(
        (model) => getTaskModelProviderId(model.id) === 'anthropic',
      ),
    ).toBe(true);
    // The static curated list plus the provider default model, all enabled.
    expect(result!.taskModelSettings.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        ...ANTHROPIC.suggestedTaskModels.map((suggestion) => suggestion.id),
        ANTHROPIC.defaultRoomoteModel,
      ]),
    );
    expect([...result!.taskModelSettings.allowedModelIds].sort()).toEqual(
      result!.taskModelSettings.models?.map((model) => model.id).sort(),
    );
    expect(result!.taskModelSettings.defaultModelId).toBe(
      ANTHROPIC.defaultRoomoteModel,
    );
  });

  it('keeps the usable default-catalog models and effective default when another provider is also connected', () => {
    const result = buildAutoAddedTaskModelSettings({
      provider: ANTHROPIC,
      persistedTaskModelSettings: null,
      connectedProviderIds: new Set(['anthropic', 'openrouter']),
    });

    expect(result).not.toBeNull();

    const modelIds = result!.taskModelSettings.models?.map((model) => model.id);

    // OpenRouter defaults survive; unusable direct-OpenAI defaults do not.
    expect(modelIds).toContain(DEFAULT_TASK_MODEL_ID);
    expect(modelIds).not.toContain('openai/gpt-5.6-terra');
    expect(modelIds).toEqual(
      expect.arrayContaining(
        ANTHROPIC.suggestedTaskModels.map((suggestion) => suggestion.id),
      ),
    );
    expect(result!.taskModelSettings.defaultModelId).toBe(
      DEFAULT_TASK_MODEL_ID,
    );
  });

  it('returns null when the current model list already has models for the provider', () => {
    expect(
      buildAutoAddedTaskModelSettings({
        provider: ANTHROPIC,
        persistedTaskModelSettings: {
          models: [
            {
              id: 'anthropic/claude-sonnet-5',
              displayName: 'Claude Sonnet 5',
              family: 'Sonnet',
            },
          ],
          allowedModelIds: ['anthropic/claude-sonnet-5'],
          defaultModelId: 'anthropic/claude-sonnet-5',
        },
        connectedProviderIds: new Set(['anthropic']),
      }),
    ).toBeNull();
  });

  it('returns null when connecting OpenRouter on a fresh deployment (defaults already cover it)', () => {
    expect(
      buildAutoAddedTaskModelSettings({
        provider: OPENROUTER,
        persistedTaskModelSettings: null,
        connectedProviderIds: new Set(['openrouter']),
      }),
    ).toBeNull();
  });

  it('appends recommended models to an existing list without changing the default', () => {
    const persisted = {
      models: [
        {
          id: 'openrouter/z-ai/glm-5.2',
          displayName: 'GLM 5.2',
          family: 'GLM',
        },
      ],
      allowedModelIds: ['openrouter/z-ai/glm-5.2'],
      defaultModelId: 'openrouter/z-ai/glm-5.2',
    };

    const result = buildAutoAddedTaskModelSettings({
      provider: ANTHROPIC,
      persistedTaskModelSettings: persisted,
      connectedProviderIds: new Set(['anthropic', 'openrouter']),
    });

    expect(result).not.toBeNull();
    expect(result!.taskModelSettings.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'openrouter/z-ai/glm-5.2',
        ...ANTHROPIC.suggestedTaskModels.map((suggestion) => suggestion.id),
      ]),
    );
    expect(result!.taskModelSettings.defaultModelId).toBe(
      'openrouter/z-ai/glm-5.2',
    );
    expect(result!.taskModelSettings.allowedModelIds).toEqual(
      expect.arrayContaining(result!.addedModels.map((model) => model.id)),
    );
  });

  it('adds the static curated list without metadata (backfilled by the refresh action)', () => {
    const result = buildAutoAddedTaskModelSettings({
      provider: GOOGLE,
      persistedTaskModelSettings: null,
      connectedProviderIds: new Set(['google']),
    });

    expect(result).not.toBeNull();
    expect([...result!.addedModels.map((model) => model.id)].sort()).toEqual(
      [...GOOGLE.suggestedTaskModels.map((suggestion) => suggestion.id)].sort(),
    );
    expect(
      result!.addedModels.every((model) => (model.metadata ?? null) === null),
    ).toBe(true);
    expect(result!.taskModelSettings.defaultModelId).toBe(
      GOOGLE.defaultRoomoteModel,
    );
  });

  it('adds default-preset models without adding models unique to another preset', () => {
    const provider = {
      ...ANTHROPIC,
      recommendedPresets: [
        {
          id: 'standard',
          label: 'Standard',
          default: true,
          roles: {
            coding: { modelId: 'anthropic/claude-sonnet-5' },
            helper: { modelId: 'anthropic/claude-haiku-4-5' },
          },
        },
        {
          id: 'review-heavy',
          label: 'Review heavy',
          roles: {
            coding: { modelId: 'anthropic/experimental-reviewer' },
            codeReview: {
              modelId: 'anthropic/experimental-reviewer',
              displayName: 'Experimental reviewer',
            },
          },
        },
      ],
    };

    const result = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings: null,
      connectedProviderIds: new Set(['anthropic']),
    });

    expect(result?.addedModels.map((model) => model.id)).toContain(
      'anthropic/claude-haiku-4-5',
    );
    expect(result?.addedModels.map((model) => model.id)).not.toContain(
      'anthropic/experimental-reviewer',
    );
  });

  it('uses the model display name for a preset model family fallback', () => {
    const provider = {
      ...ANTHROPIC,
      recommendedPresets: [
        {
          id: 'experimental',
          label: 'Experimental',
          default: true,
          roles: {
            coding: {
              modelId: 'anthropic/experimental-reviewer',
              displayName: 'Experimental reviewer',
            },
          },
        },
      ],
    };

    const result = buildAutoAddedTaskModelSettings({
      provider,
      persistedTaskModelSettings: null,
      connectedProviderIds: new Set(['anthropic']),
    });

    expect(
      result?.addedModels.find(
        (model) => model.id === 'anthropic/experimental-reviewer',
      ),
    ).toMatchObject({ family: 'Experimental' });
  });
});

describe('appendRecommendedTaskModels', () => {
  const glm = {
    id: 'openrouter/z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    family: 'GLM',
  };

  it('appends missing recommended models for connected providers, sorted by id', () => {
    const result = appendRecommendedTaskModels({
      models: [glm],
      connectedProviderIds: new Set(['anthropic']),
    });

    expect(result.map((model) => model.id)).toEqual(
      [
        ...ANTHROPIC.suggestedTaskModels.map((suggestion) => suggestion.id),
        glm.id,
      ].sort(),
    );
    expect(
      result
        .filter((model) => model.id !== glm.id)
        .every((model) => (model.metadata ?? null) === null),
    ).toBe(true);
  });

  it('keeps the models unchanged when nothing is connected or missing', () => {
    expect(
      appendRecommendedTaskModels({
        models: [glm],
        connectedProviderIds: new Set(),
      }).map((model) => model.id),
    ).toEqual([glm.id]);

    expect(
      appendRecommendedTaskModels({
        models: ANTHROPIC.suggestedTaskModels.map((suggestion) => ({
          id: suggestion.id,
          displayName: suggestion.displayName,
          family: 'Claude',
        })),
        connectedProviderIds: new Set(['anthropic']),
      }),
    ).toHaveLength(ANTHROPIC.suggestedTaskModels.length);
  });

  it('appends the ChatGPT subscription recommendations under their openai/ ids', () => {
    const result = appendRecommendedTaskModels({
      models: [],
      connectedProviderIds: new Set(['chatgpt']),
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((model) => model.id.startsWith('openai/'))).toBe(true);
  });
});

describe('appendSelectedTaskModels', () => {
  const glm = {
    id: 'openrouter/z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    family: 'GLM',
  };

  it('appends selected models that are missing from the catalog, sorted by id', () => {
    const result = appendSelectedTaskModels({
      models: [glm],
      selectedModelIds: new Set([
        'openrouter/anthropic/claude-opus-4.8',
        glm.id,
      ]),
      connectedProviderIds: new Set(['openrouter']),
    });

    expect(result.map((model) => model.id)).toEqual([
      'openrouter/anthropic/claude-opus-4.8',
      glm.id,
    ]);
    expect(
      result.find(
        (model) => model.id === 'openrouter/anthropic/claude-opus-4.8',
      ),
    ).toMatchObject({ displayName: 'claude-opus-4.8' });
  });

  it('skips selections for providers that are not connected', () => {
    expect(
      appendSelectedTaskModels({
        models: [glm],
        selectedModelIds: new Set(['anthropic/claude-opus-4.8']),
        connectedProviderIds: new Set(['openrouter']),
      }).map((model) => model.id),
    ).toEqual([glm.id]);
  });
});

describe('collectConnectedTaskModelProviderIds', () => {
  it('collects runtime-env, saved, and ChatGPT-backed providers', () => {
    const connected = collectConnectedTaskModelProviderIds({
      runtimeEnv: { OPENROUTER_API_KEY: 'runtime-key' },
      persistedEnvVarNames: ['ANTHROPIC_API_KEY'],
      chatgptConnected: true,
    });

    expect(connected.has('openrouter')).toBe(true);
    expect(connected.has('anthropic')).toBe(true);
    expect(connected.has('chatgpt')).toBe(true);
    // A ChatGPT subscription serves openai/ model ids.
    expect(connected.has('openai')).toBe(true);
    expect(connected.has('google')).toBe(false);
  });
});
