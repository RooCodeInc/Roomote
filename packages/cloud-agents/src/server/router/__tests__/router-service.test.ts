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
  ];

  function createContext(
    overrides: Partial<RoutingContext> = {},
  ): RoutingContext {
    return {
      taskDescription: 'Fix the login flow',
      source: { type: 'slack', channelName: 'engineering' },
      availableEnvironments: environments,
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
      cause: 'exception',
      debug: {
        phase: 'fallback',
        toolsUsed: [],
        needsExternalLookup: null,
        confidence: null,
        workspaceRemapped: false,
      },
    });
  });

  it('routes without selecting a task model', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: {
        workspaceValue: 'Full Stack',
        reasoning: 'Full Stack is the best fit.',
        confidence: 0.92,
        needsExternalLookup: false,
        externalReference: null,
      },
    });

    const result = await routeTask(createContext());

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') {
      throw new Error('Expected routed result');
    }

    expect(result.result).not.toHaveProperty('model');
    expect(result.result.debug).not.toHaveProperty('selectedTaskModel');
  });
});
