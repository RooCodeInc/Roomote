const mocks = vi.hoisted(() => ({
  acquireTurnLock: vi.fn(),
  releaseTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  createLauncher: vi.fn(),
  launchTask: vi.fn(),
  findSession: vi.fn(),
  findInstallation: vi.fn(),
  findArtifacts: vi.fn(),
  findTaskRun: vi.fn(),
  postMessage: vi.fn(),
  addReaction: vi.fn(),
  resolveSlackReactionNames: vi.fn(),
  createDiscordProvider: vi.fn(),
  discordPostMessage: vi.fn(),
  createDiscordThread: vi.fn(),
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  fastAgentConversationRepository: { findById: mocks.findSession },
  createFastAgentTaskLauncher:
    ({
      buildTask,
    }: {
      buildTask: (input: {
        prompt: string;
        environmentId: string | null;
        parentSessionId: string;
      }) => unknown | Promise<unknown>;
    }) =>
    async (input: {
      prompt: string;
      environmentId: string | null;
      parentSessionId: string;
      postKickoff: (task: {
        taskId: string;
        taskUrl?: string;
      }) => Promise<void>;
    }) => {
      const task = await buildTask(input);
      const taskUrl = mocks.getTaskUrl();
      await input.postKickoff({ taskId: 'child-task-1', taskUrl });
      await mocks.enqueueTask({ task });
      return { success: true, taskId: 'child-task-1', taskUrl };
    },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mocks.findInstallation },
      taskArtifacts: { findMany: mocks.findArtifacts },
      taskRuns: { findFirst: mocks.findTaskRun },
    },
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  slackInstallations: {
    isActive: 'slack_installations.is_active',
    teamId: 'slack_installations.team_id',
  },
  taskArtifacts: { id: 'task_artifacts.id' },
  taskRuns: { id: 'task_runs.id' },
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://api.roomote.example' },
  getArtifactSigningKey: vi.fn(() => 'signing-key'),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class SlackNotifier {
    postMessage = mocks.postMessage;
    addReaction = mocks.addReaction;
  },
  resolveSlackReactionNames: mocks.resolveSlackReactionNames,
  createFastAgentSlackLiveTaskLauncher: mocks.createLauncher,
}));

vi.mock('./artifacts/raw-url', () => ({
  buildSignedArtifactRawUrl: vi.fn(
    ({ artifactId }: { artifactId: string }) =>
      `https://api.roomote.example/api/artifacts/${artifactId}/raw?signed=1`,
  ),
  currentEpochSeconds: vi.fn(() => 1234),
}));

vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    mocks.createDiscordProvider,
}));

import { deliverFastAgentParentEvent } from './fast-agent-parent-event';

const parent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const event = {
  type: 'artifact_published' as const,
  taskId: 'task-1',
  runId: 42,
  artifact: {
    id: 'artifact-1',
    path: 'proof/result.png',
    version: 1,
    contentType: 'image/png',
    viewUrl:
      'https://roomote.example/task/task-1/artifacts/proof/result.png?v=1',
  },
};

describe('deliverFastAgentParentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireTurnLock.mockResolvedValue(mocks.releaseTurnLock);
    mocks.releaseTurnLock.mockResolvedValue(undefined);
    mocks.findSession.mockImplementation(
      async ({ fallbackConversation }: { fallbackConversation: unknown }) => ({
        id: parent.sessionId,
        userId: 'u1',
        conversation: fallbackConversation,
        messages: [],
      }),
    );
    mocks.findInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamDomain: 'acme',
    });
    mocks.createLauncher.mockReturnValue(mocks.launchTask);
    mocks.findArtifacts.mockResolvedValue([
      {
        id: 'artifact-1',
        taskId: 'task-1',
        runId: 42,
        path: 'proof/result.png',
        contentType: 'image/png',
        uploaded: true,
      },
    ]);
    mocks.findTaskRun.mockResolvedValue({ status: 'running' });
    mocks.postMessage.mockResolvedValue('101.001');
    mocks.addReaction.mockResolvedValue(true);
    mocks.resolveSlackReactionNames.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });
    mocks.discordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    mocks.createDiscordThread.mockResolvedValue({
      channelId: 'child-thread-1',
      parentChannelId: 'channel-1',
      messageId: 'child-message-1',
      name: 'Child task',
      kind: 'thread',
    });
    mocks.createDiscordProvider.mockResolvedValue({
      postMessage: mocks.discordPostMessage,
      createTaskThread: mocks.createDiscordThread,
    });
    mocks.getTaskUrl.mockReturnValue(
      'https://roomote.example/task/child-task-1',
    );
    mocks.enqueueTask.mockImplementation(
      async (
        _input: unknown,
        options?: {
          beforeEnqueue?: (run: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options?.beforeEnqueue?.({ taskId: 'child-task-1' });
        return { taskId: 'child-task-1' };
      },
    );
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The proof is ready.',
          imageArtifactIds: ['artifact-1', 'artifact-1'],
        }),
    );
  });

  it('serializes the event and posts one copy of a selected inline image', async () => {
    await deliverFastAgentParentEvent({ parent, event });

    expect(mocks.acquireTurnLock).toHaveBeenCalledWith({
      conversation: {
        surface: 'slack' as const,
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'C123', threadId: '100.001' },
      },
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        turnSource: 'platform_event',
        adapter: expect.objectContaining({ launchTask: mocks.launchTask }),
      }),
    );
    expect(mocks.createLauncher).toHaveBeenCalledWith({
      slack: expect.any(Object),
      userId: 'u1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
    });
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.001',
        blocks: [
          { type: 'markdown', text: 'The proof is ready.' },
          {
            type: 'image',
            image_url:
              'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
            alt_text: 'result.png',
          },
        ],
      }),
    );
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('keeps child lifecycle text private until the Fast parent composes a reply', async () => {
    const childEvent = {
      type: 'child_message' as const,
      taskId: 'task-1',
      runId: 42,
      messageId: '22222222-2222-4222-8222-222222222222',
      purpose: 'progress' as const,
      message: 'The child is running targeted tests.',
    };

    await deliverFastAgentParentEvent({ parent, event: childEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          '"message":"The child is running targeted tests."',
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'The proof is ready.',
        client_msg_id: expect.any(String),
      }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: childEvent.message }),
    );
  });

  it('uses a stable delivery key when the same child update is retried', async () => {
    const childEvent = {
      type: 'child_message' as const,
      taskId: 'task-1',
      runId: 42,
      messageId: '22222222-2222-4222-8222-222222222222',
      purpose: 'progress' as const,
      message: 'The child is running targeted tests.',
    };

    await deliverFastAgentParentEvent({ parent, event: childEvent });
    await deliverFastAgentParentEvent({ parent, event: childEvent });

    expect(mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id).toBe(
      mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id,
    );
  });

  it('does not start a model turn when the shared chat lock is unavailable', async () => {
    mocks.acquireTurnLock.mockResolvedValueOnce(null);

    await expect(
      deliverFastAgentParentEvent({ parent, event }),
    ).rejects.toThrow('turn lock did not become available');
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('delivers a guild parent event to its routable channel, not its session identity', async () => {
    const discordParent = {
      ...parent,
      conversation: {
        surface: 'discord' as const,
        workspaceId: 'guild-1',
        conversationId: 'interaction-fast-guild',
        replyTarget: { channelId: 'channel-1' },
      },
    };

    await expect(
      deliverFastAgentParentEvent({ parent: discordParent, event }),
    ).resolves.toBe('delivered');

    expect(mocks.discordPostMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      idempotencyKey: 'fast-parent-artifact:artifact-1:v1',
      text: 'The proof is ready.',
      textFormat: 'markdown',
      images: [
        {
          url: 'https://api.roomote.example/api/artifacts/artifact-1/raw?signed=1',
          altText: 'result.png',
          contentType: 'image/png',
        },
      ],
    });
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });

  it('delivers a threaded Discord parent event inside the provider thread', async () => {
    await deliverFastAgentParentEvent({
      parent: {
        ...parent,
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'thread-1',
          replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
        },
      },
      event,
    });

    expect(mocks.discordPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    );
  });

  it('uses the repository current destination instead of stale child metadata', async () => {
    mocks.findSession.mockResolvedValueOnce({
      id: parent.sessionId,
      userId: 'u1',
      messages: [],
      conversation: {
        ...parent.conversation,
        replyTarget: { channelId: 'C456', threadId: '200.002' },
      },
    });

    await deliverFastAgentParentEvent({ parent, event });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          replyTarget: { channelId: 'C456', threadId: '200.002' },
        }),
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C456', thread_ts: '200.002' }),
    );
  });

  it('keeps launch_task available during a Discord parent event', async () => {
    const postKickoff = vi.fn().mockResolvedValue(undefined);
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: { launchTask: (input: unknown) => unknown };
      }) =>
        adapter.launchTask({
          prompt: 'Fix the follow-up regression',
          environmentId: null,
          parentSessionId: parent.sessionId,
          postKickoff,
        }),
    );

    await deliverFastAgentParentEvent({
      parent: {
        ...parent,
        conversation: {
          surface: 'discord',
          workspaceId: 'guild-1',
          conversationId: 'thread-1',
          replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
        },
      },
      event,
    });

    expect(mocks.createDiscordThread).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1' }),
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationThreadId: 'child-thread-1',
            communicationContextInherited: true,
            fastAgentSessionId: parent.sessionId,
            fastAgentParent: {
              sessionId: parent.sessionId,
              conversation: {
                surface: 'discord',
                workspaceId: 'guild-1',
                conversationId: 'thread-1',
                replyTarget: {
                  channelId: 'channel-1',
                  threadId: 'thread-1',
                },
              },
            },
          }),
        }),
      }),
    );
    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'child-task-1',
      taskUrl: 'https://roomote.example/task/child-task-1',
    });
  });

  it('delivers a pull request event with a stable Slack idempotency key', async () => {
    const pullRequestEvent = {
      type: 'pull_request_opened' as const,
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      untrustedTaskGeneratedContext:
        'Fixed startup by treating absent local secrets as optional.',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: '[Fix] Keep the PR in the closeout',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The pull request is open.',
        }),
    );

    await deliverFastAgentParentEvent({
      parent,
      event: { ...pullRequestEvent, runId: 43 },
    });
    const firstClientMessageId =
      mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id;
    await deliverFastAgentParentEvent({ parent, event: pullRequestEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          pullRequestEvent.untrustedTaskGeneratedContext,
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(firstClientMessageId).toEqual(expect.any(String));
    expect(mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id).toBe(
      firstClientMessageId,
    );
  });

  it('delivers pull request feedback as a platform event with a stable idempotency key', async () => {
    const feedbackEvent = {
      type: 'pull_request_feedback' as const,
      feedbackId: 'feedback-123',
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        status: 'open' as const,
      },
      summary: 'Alice requested changes.',
      suggestedActionPrompt: 'Address the requested changes.',
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'There is new PR feedback.',
        }),
    );

    await deliverFastAgentParentEvent({ parent, event: feedbackEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('"type":"pull_request_feedback"'),
        turnSource: 'platform_event',
        platformEventVisibility: 'required',
      }),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        client_msg_id: expect.any(String),
      }),
    );
    expect(mocks.addReaction).not.toHaveBeenCalled();
  });

  it('delivers a pull request status event with a stable idempotency key', async () => {
    const statusEvent = {
      type: 'pull_request_status_changed' as const,
      taskId: 'task-1',
      runId: 42,
      taskUrl: 'https://roomote.example/task/task-1',
      pullRequest: {
        provider: 'github' as const,
        host: 'github.com',
        repository: 'acme/web',
        number: 42,
        title: 'Fix review feedback',
        url: 'https://github.com/acme/web/pull/42',
        status: 'merged' as const,
      },
      status: 'merged' as const,
      actorLogin: 'alice',
    };
    mocks.answerQuestion.mockImplementation(
      async ({
        adapter,
      }: {
        adapter: { postReply: (reply: unknown) => unknown };
      }) =>
        adapter.postReply({
          purpose: 'closeout',
          message: 'The pull request was merged.',
        }),
    );

    await deliverFastAgentParentEvent({
      parent,
      event: { ...statusEvent, runId: 43 },
    });
    const firstClientMessageId =
      mocks.postMessage.mock.calls[0]?.[0]?.client_msg_id;
    await deliverFastAgentParentEvent({ parent, event: statusEvent });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining(
          '"type":"pull_request_status_changed"',
        ),
        turnSource: 'platform_event',
      }),
    );
    expect(firstClientMessageId).toEqual(expect.any(String));
    expect(mocks.postMessage.mock.calls[1]?.[0]?.client_msg_id).toBe(
      firstClientMessageId,
    );

    await deliverFastAgentParentEvent({
      parent,
      event: {
        ...statusEvent,
        status: 'closed',
        pullRequest: { ...statusEvent.pullRequest, status: 'closed' },
      },
    });

    expect(mocks.addReaction).toHaveBeenCalledTimes(2);
    expect(mocks.addReaction).toHaveBeenLastCalledWith({
      channel: 'C123',
      timestamp: '100.001',
      name: 'white_check_mark',
    });
  });

  it('adds the merge reaction when the Fast agent ignores the status event', async () => {
    mocks.answerQuestion.mockResolvedValue(undefined);

    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'pull_request_status_changed',
        taskId: 'task-1',
        runId: 42,
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: 'acme/web',
          number: 42,
          title: 'Fix review feedback',
          url: 'https://github.com/acme/web/pull/42',
          status: 'merged',
        },
        status: 'merged',
        actorLogin: 'alice',
      },
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.addReaction).toHaveBeenCalledWith({
      channel: 'C123',
      timestamp: '100.001',
      name: 'white_check_mark',
    });
  });

  it('lets a settled task event re-query the remaining active task set', async () => {
    await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'task_settled',
        taskId: 'task-1',
        runId: 42,
        title: 'Fix API',
        status: 'completed',
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequests: [],
      },
    });

    const input = mocks.answerQuestion.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        question: expect.stringContaining('"type":"task_settled"'),
        turnSource: 'platform_event',
      }),
    );
    expect(input).not.toHaveProperty('activeTasks');
  });

  it('skips a claimed pull request event that became terminal before delivery', async () => {
    mocks.findTaskRun.mockResolvedValueOnce({ status: 'completed' });
    const result = await deliverFastAgentParentEvent({
      parent,
      event: {
        type: 'pull_request_opened',
        taskId: 'task-1',
        runId: 42,
        taskUrl: 'https://roomote.example/task/task-1',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: 'acme/web',
          number: 42,
          title: '[Fix] Keep the PR in the closeout',
          url: 'https://github.com/acme/web/pull/42',
          status: 'open',
        },
      },
    });

    expect(result).toBe('skipped');
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.releaseTurnLock).toHaveBeenCalledOnce();
  });
});
