import {
  getAllowedRouterMcpToolNames,
  getMissingRequiredRouterMcpToolGroups,
  getRequiredRouterMcpToolGroups,
  getRouterMcpServerPolicy,
  getRouterMcpToolGroupToolNames,
  getRouterMcpUpstreamConstraints,
  isRouterMcpServerEnabled,
  isRouterMcpToolAllowed,
  shouldIncludeRoomoteRouterLookup,
} from '../mcp-policy';
import {
  MCP_ROUTE_SUBMIT_TOOL,
  buildMcpAssistedRoutingContextPrompt,
  buildMcpAssistedRoutingSystemPrompt,
} from '../prompts/mcp-assisted-routing-prompt';
import {
  buildContextMessages,
  buildContextPrompt,
  buildSourceContext,
} from '../prompts/routing-context-prompt';
import { buildWorkspaceRoutingPrompt } from '../prompts/routing-prompt';
import {
  mapWorkspace,
  wasWorkspaceRemapped,
  workspaceResponseSchema,
} from '../routing-resolution';
import type { RoutingContext, RoutableEnvironment } from '../types';
import { PLATFORM_WORKSPACE_VALUE } from '../types';

describe('router helpers', () => {
  const environments: RoutableEnvironment[] = [
    {
      id: 'env-1',
      name: 'Full Stack',
      description: 'Complete development environment',
      repositoryNames: ['acme/frontend', 'acme/backend'],
    },
  ];

  const createContext = (
    overrides: Partial<RoutingContext> = {},
  ): RoutingContext => ({
    taskDescription: 'Fix the login bug',
    source: { type: 'slack', channelName: 'engineering' },
    availableEnvironments: environments,
    ...overrides,
  });

  it('builds the routing context prompt with environments', () => {
    const prompt = buildContextPrompt(createContext());

    expect(prompt).toContain('**Task Description**:');
    expect(prompt).toContain('**Available Environments**:');
    expect(prompt).toContain(
      `- ${PLATFORM_WORKSPACE_VALUE}: Generic Roomote platform questions about identity, capabilities, or getting started.`,
    );
    expect(prompt).toContain(
      '- Full Stack (repositories: acme/frontend, acme/backend)\n  Complete development environment',
    );
  });

  it('renders all repositories routing rules when configured', () => {
    const prompt = buildContextPrompt(
      createContext({
        routingRules: [
          {
            description: 'Dependency updates belong everywhere.',
            target: '__all_repositories__',
          },
        ],
      }),
    );

    expect(prompt).toContain('- __all_repositories__ (all repositories)');
    expect(prompt).toContain('Dependency updates belong everywhere.');
  });

  it('maps the all repositories workspace', () => {
    expect(
      mapWorkspace(
        '__all_repositories__',
        createContext({
          routingRules: [
            {
              description: 'Route broad changes here.',
              target: '__all_repositories__',
            },
          ],
        }),
      ),
    ).toEqual({ type: 'all_repositories' });
    expect(mapWorkspace('__all_repositories__', createContext())).toBeNull();
  });

  it('can omit the platform workspace from the available environments list', () => {
    const prompt = buildContextPrompt(createContext(), {
      includePlatformWorkspace: false,
    });

    expect(prompt).toContain('**Available Environments**:');
    expect(prompt).not.toContain(`- ${PLATFORM_WORKSPACE_VALUE}:`);
  });

  it('builds the workspace-only routing prompt', () => {
    const prompt = buildWorkspaceRoutingPrompt();

    expect(prompt).toContain('You are a workspace routing assistant');
    expect(prompt).toContain('## Custom Routing Rules');
    expect(prompt).toContain('forwarded to a task run');
    expect(prompt).toContain(`## The ${PLATFORM_WORKSPACE_VALUE} Environment`);
    expect(prompt).toContain('"What can you do?" → __platform__');
    expect(prompt).toContain(
      `"Who are you and what's your purpose?" → ${PLATFORM_WORKSPACE_VALUE}`,
    );
    expect(prompt).toContain('"List all features" → App');
    expect(prompt).toContain(
      'The task explicitly references an environment repository by its owner/repository name or a GitHub URL.',
    );
    expect(prompt).toContain(
      'A URL that identifies an owner/repository listed by an environment is still routing context',
    );
  });

  it('includes model selection rules in the routing prompt', () => {
    const prompt = buildWorkspaceRoutingPrompt();

    expect(prompt).toContain('## Model Selection');
    expect(prompt).toContain('requestedModelId');
    expect(prompt).toContain('Available Models');
  });

  it('renders the enabled model catalog in the context prompt', () => {
    const prompt = buildContextPrompt(
      createContext({
        taskModelSettings: {
          models: [
            {
              id: 'openrouter/z-ai/glm-5.2',
              displayName: 'GLM 5.2',
              family: 'GLM',
            },
            {
              id: 'openrouter/anthropic/claude-opus-4.8',
              displayName: 'Opus 4.8',
              family: 'Opus',
            },
          ],
          allowedModelIds: [
            'openrouter/z-ai/glm-5.2',
            'openrouter/anthropic/claude-opus-4.8',
          ],
          defaultModelId: 'openrouter/z-ai/glm-5.2',
        },
      }),
    );

    expect(prompt).toContain('**Available Models**:');
    expect(prompt).toContain('- GLM 5.2 [id: openrouter/z-ai/glm-5.2]');
    expect(prompt).toContain(
      '- Opus 4.8 [id: openrouter/anthropic/claude-opus-4.8]',
    );
    expect(prompt).toContain('- No model mentioned [id: __no_model__]');
  });

  it('renders the default model catalog when settings are null', () => {
    const prompt = buildContextPrompt(
      createContext({
        taskModelSettings: null,
      }),
    );

    expect(prompt).toContain('**Available Models**:');
    expect(prompt).toContain(
      '- Claude Sonnet 5 [id: openrouter/anthropic/claude-sonnet-5]',
    );
    expect(prompt).toContain(
      '- GPT 5.6 Terra [id: openrouter/openai/gpt-5.6-terra]',
    );
    expect(prompt).toContain('- No model mentioned [id: __no_model__]');
  });

  it('omits the available models section when no settings are provided', () => {
    const prompt = buildContextPrompt(createContext());

    expect(prompt).not.toContain('**Available Models**:');
  });

  it('maps environments by exact or normalized name', () => {
    expect(mapWorkspace('Full Stack', createContext())).toEqual({
      type: 'environment',
      id: 'env-1',
      name: 'Full Stack',
    });
    expect(mapWorkspace('Fullstack', createContext())).toEqual({
      type: 'environment',
      id: 'env-1',
      name: 'Full Stack',
    });
    expect(mapWorkspace('Unknown', createContext())).toBeNull();
  });

  it('defaults omitted external lookup fields to a no-lookup response', () => {
    expect(
      workspaceResponseSchema.parse({
        workspaceValue: 'Full Stack',
        reasoning: 'Best fit',
        confidence: 0.9,
      }),
    ).toEqual({
      workspaceValue: 'Full Stack',
      reasoning: 'Best fit',
      confidence: 0.9,
      kickoffMessage: null,
      needsExternalLookup: false,
      externalReference: null,
      requestedModelId: null,
      modelConfidence: null,
    });
  });

  it('preserves exact free-form environment names before normalized parsing', () => {
    const context = createContext({
      availableEnvironments: [
        ...environments,
        {
          id: 'env-2',
          name: 'workspace: staging',
          description: 'Prefixed environment name',
          repositoryNames: ['acme/staging'],
        },
        {
          id: 'env-3',
          name: '[Prod]',
          description: 'Wrapped environment name',
          repositoryNames: ['acme/prod'],
        },
      ],
    });

    expect(mapWorkspace('workspace: staging', context)).toEqual({
      type: 'environment',
      id: 'env-2',
      name: 'workspace: staging',
    });
    expect(mapWorkspace('[Prod]', context)).toEqual({
      type: 'environment',
      id: 'env-3',
      name: '[Prod]',
    });
  });

  it('detects when the final workspace was remapped', () => {
    expect(wasWorkspaceRemapped('Unknown', null)).toBe(true);

    expect(
      wasWorkspaceRemapped('Fullstack', {
        type: 'environment',
        id: 'env-1',
        name: 'Full Stack',
      }),
    ).toBe(false);

    expect(
      wasWorkspaceRemapped('Full Stack', {
        type: 'environment',
        id: 'env-1',
        name: 'Full Stack',
      }),
    ).toBe(false);

    expect(
      wasWorkspaceRemapped('workspace: staging', {
        type: 'environment',
        id: 'env-2',
        name: 'workspace: staging',
      }),
    ).toBe(false);

    expect(
      wasWorkspaceRemapped('[Prod]', {
        type: 'environment',
        id: 'env-3',
        name: '[Prod]',
      }),
    ).toBe(false);
  });

  it('builds source-specific prompt fragments', () => {
    const sourceContext = buildSourceContext({
      type: 'github',
      repository: 'acme/frontend',
      headRefName: 'roomote/fix-ci',
      prAuthorLogin: 'roomote[bot]',
      issueOrPrTitle: 'Fix login',
      issueOrPrBody: 'Line one\nLine two',
      commentBody: '@roomote are all issues addressed?\nPlease check again.',
    });

    expect(sourceContext).toContain('**Repository**: acme/frontend');
    expect(sourceContext).toContain('**Head Branch**: roomote/fix-ci');
    expect(sourceContext).toContain('**PR Author**: roomote[bot]');
    expect(sourceContext).toContain('**Body**:\n  Line one\n  Line two');
    expect(sourceContext).toContain(
      '**Comment**:\n  @roomote are all issues addressed?\n  Please check again.',
    );
    expect(sourceContext).not.toContain(
      'omitted to stay within routing budget',
    );
  });

  it('keeps GitHub routing context within the prompt budget using PR metadata and the mention body', () => {
    const sourceContext = buildSourceContext({
      type: 'github',
      repository: 'acme/frontend',
      headRefName: 'roomote/fix-ci',
      prAuthorLogin: 'roomote[bot]',
      issueOrPrTitle: 'Fix login',
      issueOrPrBody: 'A'.repeat(160_000),
      commentBody: 'B'.repeat(160_000),
    });

    expect(sourceContext.length).toBeLessThanOrEqual(250_000);
    expect(sourceContext).toContain('**Body**:\n  AAAAA');
    expect(sourceContext).toContain('**Comment**:\n  BBBBB');
    expect(sourceContext).toContain(
      '[GitHub routing context truncated to stay within routing budget]',
    );
  });

  it('includes Slack image attachments in the prompt and multimodal messages', () => {
    const context = createContext({
      source: {
        type: 'slack',
        channelName: 'engineering',
        images: ['data:image/png;base64,aGVsbG8='],
      },
    });

    expect(buildSourceContext(context.source)).toContain(
      '**Image Attachments**: 1 attached',
    );

    const [message] = buildContextMessages(context);
    expect(message).toBeDefined();
    expect(message?.role).toBe('user');
    expect(message?.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({
        type: 'image',
        image: 'aGVsbG8=',
        mediaType: 'image/png',
      }),
    ]);
  });

  it('includes Discord server, thread, and image context', () => {
    const context = createContext({
      source: {
        type: 'discord',
        guildName: 'Roomote Builders',
        channelName: 'fix-login-race',
        threadMessages: [{ user: 'Ada', text: 'The screenshot shows a 500.' }],
        images: ['data:image/png;base64,aGVsbG8='],
      },
    });

    const sourceContext = buildSourceContext(context.source);
    expect(sourceContext).toContain('**Source**: Discord');
    expect(sourceContext).toContain('**Server**: Roomote Builders');
    expect(sourceContext).toContain('**Channel**: fix-login-race');
    expect(sourceContext).toContain('**Image Attachments**: 1 attached');
    expect(sourceContext).toContain('- Ada: The screenshot shows a 500.');

    const [message] = buildContextMessages(context);
    expect(message?.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({
        type: 'image',
        image: 'aGVsbG8=',
        mediaType: 'image/png',
      }),
    ]);
  });

  it('renders Slack video attachment descriptions in the routing prompt', () => {
    const context = createContext({
      source: {
        type: 'slack',
        channelName: 'engineering',
        videoDescriptions: [
          'The user opens the settings panel and a save error appears.',
        ],
      },
    });

    expect(buildSourceContext(context.source)).toContain(
      '**Video Attachment Descriptions**:',
    );
    expect(buildSourceContext(context.source)).toContain(
      '- Video 1: The user opens the settings panel and a save error appears.',
    );
  });

  it('builds MCP-assisted routing prompts', () => {
    const systemPrompt = buildMcpAssistedRoutingSystemPrompt(
      'Base prompt',
      'LIN-123',
    );
    const contextPrompt = buildMcpAssistedRoutingContextPrompt(
      'Base context',
      ['linear'],
      'LIN-123',
    );

    expect(systemPrompt).toContain(MCP_ROUTE_SUBMIT_TOOL);
    expect(contextPrompt).toContain('External Reference To Fetch');
  });

  it('exposes the router MCP policy helpers', () => {
    const policy = getRouterMcpServerPolicy('roomote');
    const allowedTools = getAllowedRouterMcpToolNames('roomote');

    expect(policy).toBeDefined();
    expect(getRequiredRouterMcpToolGroups('roomote')).toBeDefined();
    expect(getMissingRequiredRouterMcpToolGroups('roomote', [])).toBeDefined();
    expect(allowedTools).toEqual(
      expect.arrayContaining([
        ...getRouterMcpToolGroupToolNames('roomote-platform-context'),
        ...getRouterMcpToolGroupToolNames('roomote-chat-context'),
      ]),
    );
    expect(getRouterMcpUpstreamConstraints('roomote')).toBeUndefined();
    expect(isRouterMcpServerEnabled('roomote')).toBe(true);
    expect(isRouterMcpToolAllowed('roomote', allowedTools[0]!)).toBe(true);
  });

  it('exposes only read-only GitHub Actions inspection tools', () => {
    expect(getAllowedRouterMcpToolNames('github')).toEqual(
      expect.arrayContaining(['actions_get', 'actions_list', 'get_job_logs']),
    );
    expect(getRouterMcpUpstreamConstraints('github')).toEqual({
      readonly: true,
      toolsets: ['repos', 'pull_requests', 'issues', 'actions'],
    });
    expect(isRouterMcpToolAllowed('github', 'actions_run_trigger')).toBe(false);
  });

  it('includes Roomote lookup support for Slack and Discord permalink references', () => {
    expect(
      shouldIncludeRoomoteRouterLookup(
        'https://acme.slack.com/archives/C123/p1710000000000000',
      ),
    ).toBe(true);
    expect(
      shouldIncludeRoomoteRouterLookup(
        'https://app.slack.com/client/T123/C456/thread/C456-1710000000.000100',
      ),
    ).toBe(true);
    expect(
      shouldIncludeRoomoteRouterLookup(
        'https://app.slack.com/client/T123/C456',
      ),
    ).toBe(true);
    expect(
      shouldIncludeRoomoteRouterLookup(
        'https://discord.com/channels/123/456/789',
      ),
    ).toBe(true);
    expect(
      shouldIncludeRoomoteRouterLookup(
        'Please inspect https://discord.com/channels/123/456/789 in context.',
      ),
    ).toBe(true);
    expect(shouldIncludeRoomoteRouterLookup('LIN-123')).toBe(false);

    expect(shouldIncludeRoomoteRouterLookup(null)).toBe(false);
  });
});
