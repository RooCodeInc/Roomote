const mocks = vi.hoisted(() => ({
  createFastAgentTaskLauncher: vi.fn(),
  repositoriesFindMany: vi.fn(),
  getInstallationOctokit: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentTaskLauncher: mocks.createFastAgentTaskLauncher,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...parts: unknown[]) => parts),
  db: { query: { repositories: { findMany: mocks.repositoriesFindMany } } },
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
  repositories: {},
}));

vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: ({ provider }: { provider: string }) =>
    `[footer:${provider}]`,
}));

vi.mock('@roomote/github', () => ({
  getInstallationOctokit: mocks.getInstallationOctokit,
}));

import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import {
  buildSourceControlFastAdapter,
  buildSourceControlFastConversation,
  buildSourceControlFastDelivery,
  createFastAgentSourceControlTaskLauncher,
  parseSourceControlFastConversation,
} from './source-control-fast-delivery';

describe('source-control Fast conversations', () => {
  it('round-trips a pull request discussion with its review thread', () => {
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
      reviewCommentId: '800',
    });

    expect(conversation).toEqual({
      surface: 'github',
      workspaceId: 'github.com/acme/api',
      conversationId: 'pull/42',
      replyTarget: { channelId: 'pull/42', threadId: '800' },
    });
    expect(parseSourceControlFastConversation(conversation)).toEqual({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
      reviewCommentId: '800',
    });
  });

  it('rejects identities that are not discussions', () => {
    expect(
      parseSourceControlFastConversation({
        surface: 'github',
        workspaceId: 'github.com/acme/api',
        conversationId: 'thread/1',
        replyTarget: { channelId: 'thread/1' },
      }),
    ).toBeNull();
  });
});

describe('createFastAgentSourceControlTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createFastAgentTaskLauncher.mockImplementation(() => async () => ({
      success: true,
      taskId: 'task-1',
    }));
  });

  it('binds a pull request child to the PR branch and linkage, resolving the target once', async () => {
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
    });
    const resolveTarget = vi.fn().mockResolvedValue({
      repositoryId: 'repo-1',
      branch: 'feature/ship',
      pullRequest: {
        url: 'https://github.com/acme/api/pull/42',
        title: 'Ship it',
        sha: 'abc123',
      },
    });
    const launch = createFastAgentSourceControlTaskLauncher({
      userId: 'user-1',
      conversation,
      resolveTarget,
    });
    const input = {
      prompt: 'Address the review',
      environmentId: 'env-1',
      parentSessionId: 'fast-1',
      postKickoff: vi.fn(),
    };

    await launch(input);
    await launch(input);

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    const params = mocks.createFastAgentTaskLauncher.mock.calls[0]?.[0] as {
      surface: string;
      prLinkage: Record<string, unknown>;
      buildTask: (input: Record<string, unknown>) => {
        type: string;
        payload: Record<string, unknown>;
      };
    };
    expect(params.surface).toBe('github');
    expect(params.prLinkage).toEqual({
      provider: 'github',
      host: 'github.com',
      repositoryId: 'repo-1',
      repository: 'acme/api',
      prNumber: 42,
      prUrl: 'https://github.com/acme/api/pull/42',
      prTitle: 'Ship it',
      prSha: 'abc123',
    });
    const task = params.buildTask({
      prompt: 'Address the review',
      environmentId: 'env-1',
      parentSessionId: 'fast-1',
    });
    expect(task.type).toBe(TaskPayloadKind.StandardTask);
    expect(task.payload).toMatchObject({
      repo: 'acme/api',
      branch: 'feature/ship',
      description: 'Address the review',
      environmentId: 'env-1',
      sourceControlProvider: 'github',
      sourceControlHost: 'github.com',
      reportConsumer: 'orchestrator',
      fastAgentParent: { sessionId: 'fast-1', conversation },
    });
    expect(task.payload).not.toHaveProperty('linkedWorkItems');
  });

  it('refuses to launch a pull request child when the head branch is unknown', async () => {
    const launch = createFastAgentSourceControlTaskLauncher({
      userId: 'user-1',
      conversation: buildSourceControlFastConversation({
        provider: 'github',
        host: 'github.com',
        repositoryFullName: 'acme/api',
        kind: 'pull',
        number: 42,
      }),
      resolveTarget: vi.fn().mockResolvedValue({
        repositoryId: 'repo-1',
        pullRequest: { url: 'https://github.com/acme/api/pull/42' },
      }),
    });

    await expect(
      launch({
        prompt: 'Address the review',
        environmentId: 'env-1',
        parentSessionId: 'fast-1',
        postKickoff: vi.fn(),
      }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringContaining('head branch could not be resolved'),
    });
    expect(mocks.createFastAgentTaskLauncher).not.toHaveBeenCalled();
  });

  it('links an issue child to the issue without PR linkage', async () => {
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'issues',
      number: 7,
    });
    const launch = createFastAgentSourceControlTaskLauncher({
      userId: 'user-1',
      conversation,
      resolveTarget: vi.fn().mockResolvedValue({
        repositoryId: 'repo-1',
        issue: {
          identifier: '7',
          url: 'https://github.com/acme/api/issues/7',
          title: 'Bug',
        },
      }),
    });

    await launch({
      prompt: 'Fix the bug',
      environmentId: null,
      parentSessionId: 'fast-1',
      postKickoff: vi.fn(),
    });

    const params = mocks.createFastAgentTaskLauncher.mock.calls[0]?.[0] as {
      prLinkage?: unknown;
      buildTask: (input: Record<string, unknown>) => {
        payload: Record<string, unknown>;
      };
    };
    expect(params.prLinkage).toBeUndefined();
    const payload = params.buildTask({
      prompt: 'Fix the bug',
      environmentId: ALL_REPOSITORIES,
      parentSessionId: 'fast-1',
    }).payload;
    expect(payload.linkedWorkItems).toEqual([
      {
        provider: 'github',
        identifier: '7',
        repository: 'acme/api',
        url: 'https://github.com/acme/api/issues/7',
        title: 'Bug',
      },
    ]);
    expect(payload).not.toHaveProperty('environmentId');
    expect(payload).not.toHaveProperty('branch');
  });
});

describe('GitHub Fast delivery', () => {
  const createComment = vi.fn();
  const request = vi.fn();
  const pullsGet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createComment.mockResolvedValue({ data: { id: 5001 } });
    request.mockResolvedValue({ data: { id: 5002 } });
    pullsGet.mockResolvedValue({
      data: {
        head: { ref: 'feature/ship', sha: 'abc123' },
        html_url: 'https://github.com/acme/api/pull/42',
        title: 'Ship it',
      },
    });
    mocks.getInstallationOctokit.mockResolvedValue({
      rest: { issues: { createComment }, pulls: { get: pullsGet } },
      request,
    });
    mocks.repositoriesFindMany.mockResolvedValue([
      {
        id: 'repo-1',
        host: null,
        githubInstallation: { installationId: 123 },
      },
    ]);
  });

  it('returns null for a repository that is not connected', async () => {
    mocks.repositoriesFindMany.mockResolvedValue([]);

    await expect(
      buildSourceControlFastDelivery({
        surface: 'github',
        workspaceId: 'github.com/acme/api',
        conversationId: 'pull/42',
        replyTarget: { channelId: 'pull/42' },
      }),
    ).resolves.toBeNull();
  });

  it('posts replies as PR comments with the Session footer and resolves the PR target', async () => {
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
    });
    const delivery = await buildSourceControlFastDelivery(conversation);
    expect(delivery).not.toBeNull();
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });

    await expect(adapter.postReply({ message: 'On it.' })).resolves.toEqual({
      messageId: '5001',
    });
    expect(createComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'api',
      issue_number: 42,
      body: 'On it.\n\n[footer:github]',
    });
    await expect(delivery!.resolveTarget()).resolves.toEqual({
      repositoryId: 'repo-1',
      branch: 'feature/ship',
      pullRequest: {
        url: 'https://github.com/acme/api/pull/42',
        title: 'Ship it',
        sha: 'abc123',
      },
    });
  });

  it('threads replies under the review comment the mention came from', async () => {
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
      reviewCommentId: '800',
    });
    const delivery = await buildSourceControlFastDelivery(conversation);
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });

    await expect(adapter.postReply({ message: 'Fixed.' })).resolves.toEqual({
      messageId: '5002',
    });
    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      expect.objectContaining({ pull_number: 42, comment_id: 800 }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
