import { DEFAULT_TASK_MODEL_SETTINGS } from '@roomote/types';

import type { RoutingContext, RoutableEnvironment } from '../types';
import { routeTask } from '../router-service';

const { mockGenerateTrackedNonTaskObject } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

const { mockCallRouterMcpTool } = vi.hoisted(() => ({
  mockCallRouterMcpTool: vi.fn(),
}));

vi.mock('../../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

vi.mock('../mcp-tool-call', () => ({
  callRouterMcpTool: mockCallRouterMcpTool,
}));

describe('routeTask', () => {
  const environments: RoutableEnvironment[] = [
    {
      id: 'env-full-stack',
      name: 'Full Stack',
      description: 'Main app workspace',
      repositoryNames: ['acme/web', 'acme/api'],
    },
    {
      id: 'env-api',
      name: 'API',
      description: 'Backend services',
      repositoryNames: ['acme/api'],
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

  it('uses recent correction memory only to resolve a low-confidence route', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Both environments could contain the work.',
        confidence: 0.5,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(
      createContext({
        environmentPreference: {
          environmentId: 'env-api',
          correctionCount: 2,
          lastCorrectedAt: new Date(),
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-api', name: 'API' },
        kickoffMessage: undefined,
        debug: {
          environmentSource: 'memory',
          environmentPreferenceWeight: expect.any(Number),
        },
      },
    });
  });

  it('does not let memory override a confident router decision', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'The login flow belongs in Full Stack.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(
      createContext({
        environmentPreference: {
          environmentId: 'env-api',
          correctionCount: 3,
          lastCorrectedAt: new Date(),
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-full-stack' },
        debug: { environmentSource: 'router' },
      },
    });
  });

  it('does not let memory override an explicit environment mention', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'The user named Full Stack.',
        confidence: 0.4,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(
      createContext({
        taskDescription: 'Use Full Stack for this task.',
        environmentPreference: {
          environmentId: 'env-api',
          correctionCount: 3,
          lastCorrectedAt: new Date(),
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-full-stack' },
        debug: { environmentSource: 'router' },
      },
    });
  });

  it('expires a one-off correction after its half-life', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Both environments could contain the work.',
        confidence: 0.4,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(
      createContext({
        environmentPreference: {
          environmentId: 'env-api',
          correctionCount: 1,
          lastCorrectedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'routed',
      result: {
        workspace: { type: 'environment', id: 'env-full-stack' },
        debug: { environmentSource: 'router' },
      },
    });
  });

  it('fetches pasted GitHub issue context when the precheck asks for it', async () => {
    mockCallRouterMcpTool.mockResolvedValue({
      title: 'Fix the dashboard refresh failure',
      body: 'The dashboard API request belongs to the web application.',
    });
    mockGenerateTrackedNonTaskObject
      .mockResolvedValueOnce({
        object: {
          workspaceValue: 'Full Stack',
          reasoning: 'The message alone does not identify the workspace.',
          confidence: 0.4,
          needsExternalLookup: true,
          externalReference: 'acme/web#42',
        },
      })
      .mockResolvedValueOnce({
        object: {
          workspaceValue: 'Full Stack',
          reasoning: 'The linked issue describes the web application.',
          confidence: 0.92,
          needsExternalLookup: false,
          externalReference: null,
        },
      });

    const result = await routeTask(
      createContext({
        taskDescription:
          'Please investigate https://github.com/acme/web/issues/42',
      }),
    );

    expect(mockCallRouterMcpTool).toHaveBeenCalledWith({
      context: expect.objectContaining({
        taskDescription:
          'Please investigate https://github.com/acme/web/issues/42',
      }),
      serverId: 'github',
      toolName: 'issue_read',
      args: {
        method: 'get',
        owner: 'acme',
        repo: 'web',
        issue_number: 42,
      },
    });
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(2);
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Fix the dashboard refresh failure'),
      }),
    );
    expect(result).toMatchObject({
      status: 'routed',
      result: {
        debug: {
          phase: 'mcp',
          toolsUsed: ['github.issue_read'],
          needsExternalLookup: true,
        },
      },
    });
  });

  it('skips the issue fetch when the precheck routes without external context', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'The message already identifies the dashboard work.',
        confidence: 0.95,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(
      createContext({
        taskDescription:
          'Fix the dashboard refresh bug, context: https://github.com/acme/web/issues/42',
      }),
    );

    expect(mockCallRouterMcpTool).not.toHaveBeenCalled();
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'routed',
      result: {
        debug: {
          phase: 'direct',
          toolsUsed: [],
          needsExternalLookup: false,
        },
      },
    });
  });

  it('resolves a bare issue reference from the precheck against configured repos', async () => {
    mockCallRouterMcpTool.mockResolvedValue({
      title: 'Dashboard export button broken',
    });
    mockGenerateTrackedNonTaskObject
      .mockResolvedValueOnce({
        object: {
          workspaceValue: 'Full Stack',
          reasoning: 'The message references an issue by number only.',
          confidence: 0.4,
          needsExternalLookup: true,
          externalReference: '#234',
        },
      })
      .mockResolvedValueOnce({
        object: {
          workspaceValue: 'Full Stack',
          reasoning: 'The referenced issue describes dashboard work.',
          confidence: 0.9,
          needsExternalLookup: false,
          externalReference: null,
        },
      });

    const result = await routeTask(
      createContext({ taskDescription: 'Check issue #234' }),
    );

    expect(mockCallRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'github',
        toolName: 'issue_read',
        args: expect.objectContaining({ issue_number: 234 }),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'routed',
      result: {
        debug: {
          phase: 'mcp',
          needsExternalLookup: true,
        },
      },
    });
  });

  it('keeps the precheck decision when the requested fetch returns nothing', async () => {
    mockCallRouterMcpTool.mockRejectedValue(new Error('Not connected'));
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Best guess without the linked issue.',
        confidence: 0.4,
        needsExternalLookup: true,
        externalReference: 'acme/web#42',
      },
    });

    const result = await routeTask(
      createContext({
        taskDescription:
          'Please investigate https://github.com/acme/web/issues/42',
      }),
    );

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'routed',
      result: {
        debug: {
          phase: 'direct',
          toolsUsed: [],
          needsExternalLookup: true,
        },
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
        requestedModelId: 'openrouter/anthropic/claude-opus-5',
        modelConfidence: 0.97,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
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
        requestedModelId: 'openrouter/anthropic/claude-opus-5',
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
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
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
        requestedModelId: 'openrouter/anthropic/claude-opus-5',
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
        id: 'openrouter/anthropic/claude-opus-5',
        displayName: 'Claude Opus 5',
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
        requestedModelId: 'openrouter/anthropic/claude-opus-5',
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
        id: 'openrouter/anthropic/claude-opus-5',
        displayName: 'Claude Opus 5',
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
          modelId: 'openrouter/anthropic/claude-opus-5',
          modelDisplayName: 'Claude Opus 5',
        },
      }),
    );

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
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
          modelId: 'openrouter/anthropic/claude-opus-5',
          modelDisplayName: 'Claude Opus 5',
        },
      }),
    );

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result.model).toEqual({
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
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
