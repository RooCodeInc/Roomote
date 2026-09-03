const mocks = vi.hoisted(() => ({
  createFastAgentTaskLauncher: vi.fn(),
  findConnection: vi.fn(),
  getValidAccessToken: vi.fn(),
  createLinearClient: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentTaskLauncher: mocks.createFastAgentTaskLauncher,
}));

vi.mock('@roomote/db/server', () => ({
  asc: vi.fn(),
  db: {},
  eq: vi.fn(),
  users: {},
}));

vi.mock('@roomote/linear', () => ({
  createLinearClient: mocks.createLinearClient,
}));

vi.mock('./mcp/data', () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));

vi.mock('./mcp/linear-connections', () => ({
  findLinearDeploymentMcpConnectionByIdentity: mocks.findConnection,
}));

import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import {
  buildLinearFastConversation,
  createFastAgentLinearTaskLauncher,
  resolveLinearFastSessionClient,
} from './linear-fast-session';

const conversation = buildLinearFastConversation({
  organizationId: 'org-1',
  agentSessionId: 'session-1',
});

describe('resolveLinearFastSessionClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a client for a connected organization with a valid token', async () => {
    mocks.findConnection.mockResolvedValue({ id: 'conn-1' });
    mocks.getValidAccessToken.mockResolvedValue('token-1');
    mocks.createLinearClient.mockReturnValue({ id: 'client' });

    await expect(resolveLinearFastSessionClient('org-1')).resolves.toEqual({
      id: 'client',
    });
    expect(mocks.findConnection).toHaveBeenCalledWith({
      linearOrganizationId: 'org-1',
    });
    expect(mocks.createLinearClient).toHaveBeenCalledWith('token-1');
  });

  it('returns null without a connection or a token', async () => {
    mocks.findConnection.mockResolvedValue(null);
    await expect(resolveLinearFastSessionClient('org-1')).resolves.toBeNull();

    mocks.findConnection.mockResolvedValue({ id: 'conn-1' });
    mocks.getValidAccessToken.mockResolvedValue(undefined);
    await expect(resolveLinearFastSessionClient('org-1')).resolves.toBeNull();
  });
});

describe('createFastAgentLinearTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createFastAgentTaskLauncher.mockImplementation(() => async () => ({
      success: true,
      taskId: 'task-1',
    }));
  });

  it('binds the child to the agent session and links its issue, resolving the issue once', async () => {
    const resolveIssue = vi.fn().mockResolvedValue({
      id: 'issue-1',
      identifier: 'ENG-123',
      title: 'Fix API retries',
      url: 'https://linear.app/acme/issue/ENG-123',
    });
    const launch = createFastAgentLinearTaskLauncher({
      userId: 'user-1',
      conversation,
      resolveIssue,
    });
    const input = {
      prompt: 'Fix the retry loop',
      environmentId: 'env-1',
      parentSessionId: 'fast-1',
      postKickoff: vi.fn(),
    };

    await launch(input);
    await launch(input);

    expect(resolveIssue).toHaveBeenCalledTimes(1);
    const params = mocks.createFastAgentTaskLauncher.mock.calls[0]?.[0] as {
      surface: string;
      channels: Record<string, string>;
      buildTask: (input: Record<string, unknown>) => {
        type: string;
        payload: Record<string, unknown>;
      };
    };
    expect(params.surface).toBe('linear');
    expect(params.channels).toEqual({
      linearSessionId: 'session-1',
      linearOrganizationId: 'org-1',
      linearIssueId: 'issue-1',
    });
    const task = params.buildTask({
      prompt: 'Fix the retry loop',
      environmentId: 'env-1',
      parentSessionId: 'fast-1',
      model: 'openrouter/z-ai/glm-5.2',
    });
    expect(task.type).toBe(TaskPayloadKind.StandardTask);
    expect(task.payload).toMatchObject({
      repo: ALL_REPOSITORIES,
      description: 'Fix the retry loop',
      environmentId: 'env-1',
      reportConsumer: 'orchestrator',
      fastAgentSessionId: 'fast-1',
      fastAgentParent: { sessionId: 'fast-1', conversation },
      linkedWorkItems: [
        {
          provider: 'linear',
          identifier: 'ENG-123',
          url: 'https://linear.app/acme/issue/ENG-123',
          title: 'Fix API retries',
        },
      ],
      harnessModelOverrides: { 'opencode-server': 'openrouter/z-ai/glm-5.2' },
    });
  });

  it('still launches when the issue cannot be resolved', async () => {
    const launch = createFastAgentLinearTaskLauncher({
      userId: 'user-1',
      conversation,
      resolveIssue: vi.fn().mockResolvedValue(null),
    });

    await launch({
      prompt: 'Fix the retry loop',
      environmentId: null,
      parentSessionId: 'fast-1',
      postKickoff: vi.fn(),
    });

    const params = mocks.createFastAgentTaskLauncher.mock.calls[0]?.[0] as {
      channels: Record<string, string>;
      buildTask: (input: Record<string, unknown>) => {
        payload: Record<string, unknown>;
      };
    };
    expect(params.channels).toEqual({
      linearSessionId: 'session-1',
      linearOrganizationId: 'org-1',
    });
    expect(
      params.buildTask({
        prompt: 'x',
        environmentId: null,
        parentSessionId: 'fast-1',
      }).payload,
    ).not.toHaveProperty('linkedWorkItems');
  });
});
