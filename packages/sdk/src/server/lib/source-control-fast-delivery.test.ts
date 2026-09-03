const mocks = vi.hoisted(() => ({
  createFastAgentTaskLauncher: vi.fn(),
  repositoriesFindMany: vi.fn(),
  getInstallationOctokit: vi.fn(),
  gitlabCreateIssueNote: vi.fn(),
  gitlabCreateMergeRequestNote: vi.fn(),
  gitlabGetMergeRequest: vi.fn(),
  giteaCreateIssueComment: vi.fn(),
  giteaCreatePullRequestComment: vi.fn(),
  giteaGetPullRequest: vi.fn(),
  bitbucketCreateComment: vi.fn(),
  bitbucketGetPullRequest: vi.fn(),
  adoCreatePullRequestComment: vi.fn(),
  adoCreateWorkItemComment: vi.fn(),
  adoGetPullRequest: vi.fn(),
  adoListRepositories: vi.fn(),
  gitlabUpdateNote: vi.fn(),
  giteaUpdateComment: vi.fn(),
  bitbucketUpdateComment: vi.fn(),
  adoUpdatePullRequestComment: vi.fn(),
  adoUpdateWorkItemComment: vi.fn(),
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

vi.mock('@roomote/gitlab', () => ({
  createGitLabIssueNote: mocks.gitlabCreateIssueNote,
  createGitLabMergeRequestNote: mocks.gitlabCreateMergeRequestNote,
  getGitLabMergeRequest: mocks.gitlabGetMergeRequest,
  updateGitLabNote: mocks.gitlabUpdateNote,
}));

vi.mock('@roomote/gitea', () => ({
  createGiteaIssueComment: mocks.giteaCreateIssueComment,
  createGiteaPullRequestComment: mocks.giteaCreatePullRequestComment,
  getGiteaPullRequest: mocks.giteaGetPullRequest,
  updateGiteaComment: mocks.giteaUpdateComment,
}));

vi.mock('@roomote/bitbucket', () => ({
  createBitbucketPullRequestComment: mocks.bitbucketCreateComment,
  getBitbucketPullRequest: mocks.bitbucketGetPullRequest,
  updateBitbucketPullRequestComment: mocks.bitbucketUpdateComment,
}));

vi.mock('@roomote/ado', () => ({
  createAdoPullRequestComment: mocks.adoCreatePullRequestComment,
  createAdoWorkItemComment: mocks.adoCreateWorkItemComment,
  getAdoPullRequest: mocks.adoGetPullRequest,
  listAdoRepositories: mocks.adoListRepositories,
  updateAdoPullRequestComment: mocks.adoUpdatePullRequestComment,
  updateAdoWorkItemComment: mocks.adoUpdateWorkItemComment,
  parseAdoRepositoryFullName: (fullName: string) => {
    const [organization, project, repository] = fullName.split('/');
    return { organization, project, repository };
  },
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

  it('edits the turn comment in place for later replies instead of posting again', async () => {
    const updateComment = vi.fn().mockResolvedValue({});
    mocks.getInstallationOctokit.mockResolvedValue({
      rest: {
        issues: {
          createComment: createComment.mockResolvedValue({
            data: { id: 6001 },
          }),
          updateComment,
        },
        pulls: { get: pullsGet },
      },
      request,
    });
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
    });
    const delivery = await buildSourceControlFastDelivery(conversation);
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });

    await adapter.postReply({ message: 'On it.' });
    const second = await adapter.postReply({
      message: 'Rebased; running checks.',
    });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 6001,
        body: expect.stringContaining('On it.\n\nRebased; running checks.'),
      }),
    );
    // Footer appears once, at the bottom of the edited body.
    const body = updateComment.mock.calls[0]?.[0].body as string;
    expect(body.match(/footer:github/g)).toHaveLength(1);
    expect(second).toEqual({ messageId: '6001' });
  });

  it('replaces a resumed turn comment by id and keeps appending into it', async () => {
    const updateComment = vi.fn().mockResolvedValue({});
    mocks.getInstallationOctokit.mockResolvedValue({
      rest: {
        issues: { createComment, updateComment },
        pulls: { get: pullsGet },
      },
      request,
    });
    const conversation = buildSourceControlFastConversation({
      provider: 'github',
      host: 'github.com',
      repositoryFullName: 'acme/api',
      kind: 'pull',
      number: 42,
    });
    const delivery = await buildSourceControlFastDelivery(conversation);
    // A fresh adapter, as a resumed process would build: no in-memory state.
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });

    const replaced = await adapter.replaceReply!(
      { messageId: '7001' },
      { message: 'Recovered; here is the result.' },
    );
    await adapter.postReply({ message: 'And one more detail.' });

    expect(replaced).toEqual({ messageId: '7001' });
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        comment_id: 7001,
        body: expect.stringContaining('Recovered; here is the result.'),
      }),
    );
    expect(updateComment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        comment_id: 7001,
        body: expect.stringContaining(
          'Recovered; here is the result.\n\nAnd one more detail.',
        ),
      }),
    );
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

describe('other provider Fast deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoriesFindMany.mockResolvedValue([
      { id: 'repo-1', host: 'git.example.com' },
    ]);
  });

  it('posts GitLab merge request notes by project path and resolves the source branch', async () => {
    mocks.gitlabCreateMergeRequestNote.mockResolvedValue({ id: 71 });
    mocks.gitlabGetMergeRequest.mockResolvedValue({
      iid: 42,
      title: 'Update backend',
      web_url: 'https://git.example.com/acme/backend/-/merge_requests/42',
      source_branch: 'feature/test',
      sha: 'abc123',
    });
    const conversation = buildSourceControlFastConversation({
      provider: 'gitlab',
      host: 'git.example.com',
      repositoryFullName: 'acme/backend',
      kind: 'pull',
      number: 42,
    });

    const delivery = await buildSourceControlFastDelivery(conversation);
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });

    await expect(adapter.postReply({ message: 'On it.' })).resolves.toEqual({
      messageId: '71',
    });
    expect(mocks.gitlabCreateMergeRequestNote).toHaveBeenCalledWith({
      projectId: 'acme/backend',
      mergeRequestIid: 42,
      body: 'On it.\n\n[footer:gitlab]',
    });
    await expect(delivery!.resolveTarget()).resolves.toEqual({
      repositoryId: 'repo-1',
      branch: 'feature/test',
      pullRequest: {
        url: 'https://git.example.com/acme/backend/-/merge_requests/42',
        title: 'Update backend',
        sha: 'abc123',
      },
    });
  });

  it('posts Gitea issue comments and links the issue as the launch target', async () => {
    mocks.giteaCreateIssueComment.mockResolvedValue({ id: 12 });
    const conversation = buildSourceControlFastConversation({
      provider: 'gitea',
      host: 'git.example.com',
      repositoryFullName: 'acme/backend',
      kind: 'issues',
      number: 7,
    });

    const delivery = await buildSourceControlFastDelivery(conversation);
    await delivery!.postComment({
      discussion: {
        provider: 'gitea',
        host: 'git.example.com',
        repositoryFullName: 'acme/backend',
        kind: 'issues',
        number: 7,
      },
      body: 'Looking.',
    });

    expect(mocks.giteaCreateIssueComment).toHaveBeenCalledWith({
      repositoryFullName: 'acme/backend',
      issueNumber: 7,
      body: 'Looking.',
    });
    await expect(delivery!.resolveTarget()).resolves.toEqual({
      repositoryId: 'repo-1',
      issue: {
        identifier: '7',
        url: 'https://git.example.com/acme/backend/issues/7',
      },
    });
  });

  it('resolves the Azure DevOps repository GUID once and threads replies', async () => {
    mocks.adoListRepositories.mockResolvedValue([
      { id: 'guid-1', name: 'backend', project: { name: 'Platform' } },
    ]);
    mocks.adoCreatePullRequestComment.mockResolvedValue({
      threadId: '5',
      commentId: '901',
    });
    mocks.adoGetPullRequest.mockResolvedValue({
      pullRequestId: 42,
      title: 'Update backend',
      sourceRefName: 'refs/heads/feature/test',
      lastMergeSourceCommit: { commitId: 'abc123' },
      repository: {
        webUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      },
    });
    mocks.repositoriesFindMany.mockResolvedValue([
      { id: 'repo-1', host: 'dev.azure.com' },
    ]);
    const conversation = buildSourceControlFastConversation({
      provider: 'ado',
      host: 'dev.azure.com',
      repositoryFullName: 'acme/Platform/backend',
      kind: 'pull',
      number: 42,
      reviewCommentId: '5',
      replyCommentId: '900',
    });
    expect(conversation.replyTarget.threadId).toBe('5:900');

    const delivery = await buildSourceControlFastDelivery(conversation);
    const adapter = buildSourceControlFastAdapter({
      conversation,
      delivery: delivery!,
      userId: 'user-1',
      sessionId: 'fast-1',
    });
    const adoPosted = await adapter.postReply({ message: 'On it.' });
    expect(adoPosted).toEqual({ messageId: 'thread:5:901' });
    await delivery!.resolveTarget();

    expect(mocks.adoListRepositories).toHaveBeenCalledTimes(1);
    expect(mocks.adoCreatePullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'guid-1',
        pullRequestNumber: 42,
        threadId: '5',
        parentCommentId: '900',
        organization: 'acme',
      }),
    );
    await expect(delivery!.resolveTarget()).resolves.toEqual({
      repositoryId: 'repo-1',
      branch: 'feature/test',
      pullRequest: {
        url: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        title: 'Update backend',
        sha: 'abc123',
      },
    });
  });

  it('returns null for a Bitbucket issue discussion', async () => {
    await expect(
      buildSourceControlFastDelivery(
        buildSourceControlFastConversation({
          provider: 'bitbucket',
          host: 'bitbucket.org',
          repositoryFullName: 'acme/repo',
          kind: 'issues',
          number: 3,
        }),
      ),
    ).resolves.toBeNull();
  });
});
