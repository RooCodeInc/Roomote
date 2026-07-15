import { DEFAULT_TASK_MODEL_SETTINGS } from '@roomote/types';

import type { RoutingContext, RoutableEnvironment } from '../types';
import { routeTask } from '../router-service';

const { mockGenerateTrackedNonTaskObject } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

vi.mock('../../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

describe('routeTask', () => {
  const environments: RoutableEnvironment[] = [
    {
      id: 'env-full-stack',
      name: 'Full Stack',
      description: 'Main app workspace',
      repositoryNames: ['acme/web', 'acme/api'],
    },
  ];

  function createContext(
    overrides: Partial<RoutingContext> = {},
  ): RoutingContext {
    return {
      taskDescription: 'Fix the login flow',
      source: { type: 'slack', channelName: 'engineering' },
      availableEnvironments: environments,
      taskModelSettings: DEFAULT_TASK_MODEL_SETTINGS,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes through direct structured output even when no routing actor is available', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        kickoffMessage:
          'Looking into daily environment snapshots for faster startup in Full Stack',
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: undefined,
        model: undefined,
        system: expect.stringContaining(
          'You are a workspace routing assistant',
        ),
      }),
    );
    expect(result.result).toMatchObject({
      workspaceOnly: true,
      reasoning: 'Full Stack is the best fit.',
      workspace: {
        type: 'environment',
        id: 'env-full-stack',
        name: 'Full Stack',
      },
      kickoffMessage:
        'Looking into daily environment snapshots for faster startup in Full Stack',
      debug: {
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: 0.92,
        workspaceRemapped: false,
      },
    });
  });

  it('returns the underlying structured-output failure instead of a generic no-response fallback', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValue(
      new Error(
        'OpenCode structured prompt failed: StructuredOutputError: failed to satisfy schema',
      ),
    );

    const result = await routeTask(createContext());

    expect(result).toEqual({
      status: 'fallback',
      reason:
        'OpenCode structured prompt failed: StructuredOutputError: failed to satisfy schema',
      debug: {
        phase: 'fallback',
        toolsUsed: [],
        needsExternalLookup: null,
        confidence: null,
        workspaceRemapped: false,
      },
    });
  });

  it('uses the LLM-requested model as a preference when it is enabled and confident', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/anthropic/claude-opus-4.8',
        modelConfidence: 0.97,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-4.8',
      displayName: 'Claude Opus 4.8',
      source: 'preference',
      confidence: 0.97,
    });
    expect(result.result.debug?.selectedTaskModel).toEqual(result.result.model);
  });

  it('uses the LLM-requested model against the default catalog when settings are null', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/anthropic/claude-opus-4.8',
        modelConfidence: 0.95,
      },
    });

    const result = await routeTask(
      createContext({
        taskModelSettings: null,
      }),
    );

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-4.8',
      displayName: 'Claude Opus 4.8',
      source: 'preference',
      confidence: 0.95,
    });
  });

  it('demotes an LLM-requested model with confidence below the threshold and records the rejected pick', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/anthropic/claude-opus-4.8',
        modelConfidence: 0.6,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: DEFAULT_TASK_MODEL_SETTINGS.defaultModelId,
      displayName: expect.any(String),
      source: 'default',
      rejectedPick: {
        id: 'openrouter/anthropic/claude-opus-4.8',
        displayName: 'Claude Opus 4.8',
        confidence: 0.6,
        reason: 'below_threshold',
      },
    });
    expect(result.result.debug?.selectedTaskModel).toEqual(result.result.model);
  });

  it('demotes an LLM-requested model when the model confidence is missing', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/anthropic/claude-opus-4.8',
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: DEFAULT_TASK_MODEL_SETTINGS.defaultModelId,
      displayName: expect.any(String),
      source: 'default',
      rejectedPick: {
        id: 'openrouter/anthropic/claude-opus-4.8',
        displayName: 'Claude Opus 4.8',
        confidence: null,
        reason: 'below_threshold',
      },
    });
  });

  it('treats the __no_model__ sentinel as no model preference and records its confidence', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: '__no_model__',
        modelConfidence: 0.98,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: DEFAULT_TASK_MODEL_SETTINGS.defaultModelId,
      displayName: expect.any(String),
      source: 'default',
      noModelChoice: { confidence: 0.98 },
    });
  });

  it('falls back to the deployment default when the LLM does not request a model', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: null,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: DEFAULT_TASK_MODEL_SETTINGS.defaultModelId,
      displayName: expect.any(String),
      source: 'default',
    });
  });

  it('preserves the previous suggestion model when correcting without a new model preference', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: null,
      },
    });

    const result = await routeTask(
      createContext({
        previousSuggestion: {
          workspaceValue: 'Full Stack',
          workspaceDisplayName: 'Full Stack',
          modelId: 'openrouter/anthropic/claude-opus-4.8',
          modelDisplayName: 'Claude Opus 4.8',
        },
      }),
    );

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-4.8',
      displayName: 'Claude Opus 4.8',
      source: 'preserved',
    });
  });

  it('preserves the previous suggestion model over a low-confidence pick and records the rejected pick', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/openai/gpt-5.6-terra',
        modelConfidence: 0.4,
      },
    });

    const result = await routeTask(
      createContext({
        previousSuggestion: {
          workspaceValue: 'Full Stack',
          workspaceDisplayName: 'Full Stack',
          modelId: 'openrouter/anthropic/claude-opus-4.8',
          modelDisplayName: 'Claude Opus 4.8',
        },
      }),
    );

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-4.8',
      displayName: 'Claude Opus 4.8',
      source: 'preserved',
      rejectedPick: {
        id: 'openrouter/openai/gpt-5.6-terra',
        displayName: 'GPT 5.6 Terra',
        confidence: 0.4,
        reason: 'below_threshold',
      },
    });
  });

  it('ignores an LLM-requested model that is not in the deployment allow-list', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
        requestedModelId: 'openrouter/unknown/disabled-model',
        modelConfidence: 0.95,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: DEFAULT_TASK_MODEL_SETTINGS.defaultModelId,
      displayName: expect.any(String),
      source: 'default',
      rejectedPick: {
        id: 'openrouter/unknown/disabled-model',
        displayName: 'openrouter/unknown/disabled-model',
        confidence: 0.95,
        reason: 'not_allowed',
      },
    });
  });
});
