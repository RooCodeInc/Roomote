import type { SlackInteractivePayload } from '@roomote/slack';

const {
  claimPendingMock,
  postSlackInteractiveResponseMock,
  queueSlackMessageMock,
  resolveSlackReactionNamesMock,
  setTrustedRunActingUserMock,
  slackUserMappingsFindFirstMock,
  dbSelectMock,
  resolveRouteMock,
  dispatchFollowUpMock,
  processSnapshotResumeMock,
  updateMessageMock,
} = vi.hoisted(() => ({
  claimPendingMock: vi.fn(),
  postSlackInteractiveResponseMock: vi.fn(),
  queueSlackMessageMock: vi.fn(),
  resolveSlackReactionNamesMock: vi.fn(),
  setTrustedRunActingUserMock: vi.fn(),
  slackUserMappingsFindFirstMock: vi.fn(),
  dbSelectMock: vi.fn(),
  resolveRouteMock: vi.fn(),
  dispatchFollowUpMock: vi.fn(),
  processSnapshotResumeMock: vi.fn(),
  updateMessageMock: vi.fn(),
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/slack')>();

  class MockSlackNotifier {
    updateMessage = updateMessageMock;
  }

  return {
    ...original,
    claimPendingSlackPrReviewAction: claimPendingMock,
    postSlackInteractiveResponse: postSlackInteractiveResponseMock,
    queueSlackMessage: queueSlackMessageMock,
    resolveSlackReactionNames: resolveSlackReactionNamesMock,
    SlackNotifier: MockSlackNotifier,
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  db: {
    select: dbSelectMock,
    query: {
      slackUserMappings: {
        findFirst: slackUserMappingsFindFirstMock,
      },
    },
  },
  setTrustedRunActingUser: setTrustedRunActingUserMock,
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: { slackUserId: 'slackUserId', slackTeamId: 'slackTeamId' },
}));

vi.mock('../../events/thread-follow-up-dispatch.js', () => ({
  resolveSlackThreadFollowUpRoute: resolveRouteMock,
  dispatchSlackThreadFollowUp: dispatchFollowUpMock,
}));

vi.mock('../../events/snapshot-resume.js', () => ({
  processSnapshotResume: processSnapshotResumeMock,
}));

import {
  handleSlackPrReviewActionDismiss,
  handleSlackPrReviewActionYes,
} from '../pr-review-action.js';

const pendingAction = {
  nonce: 'nonce-1',
  taskId: 'task-1',
  repository: 'owner/repo',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  channelId: 'C123',
  threadTs: '111.222',
  followUpPrompt: 'Address the review feedback on owner/repo#42.',
};

function makePayload(actionId: string): SlackInteractivePayload {
  return {
    type: 'block_actions',
    team: { id: 'T1', domain: 'team' },
    user: { id: 'U1', name: 'dan' },
    channel: { id: 'C123', name: 'general' },
    message: {
      ts: '333.444',
      thread_ts: '111.222',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'summary' } },
        {
          type: 'section',
          block_id: 'pr_review_action_question',
          text: { type: 'mrkdwn', text: 'Want me to take a look?' },
        },
        { type: 'actions', block_id: 'pr_review_action', elements: [] },
        { type: 'context', elements: [] },
      ],
    },
    actions: [
      {
        type: 'button',
        action_id: actionId,
        text: { text: 'Yes' },
        value: JSON.stringify({ nonce: 'nonce-1' }),
      },
    ],
    state: { values: {} },
    response_url: 'https://hooks.slack.test/response',
    trigger_id: 'trigger-1',
  };
}

describe('handleSlackPrReviewActionYes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    slackUserMappingsFindFirstMock.mockResolvedValue({ userId: 'user-1' });
    claimPendingMock.mockResolvedValue(pendingAction);
    dbSelectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            { botAccessToken: 'xoxb-token', botUserId: 'B1' },
          ],
        }),
      }),
    });
    resolveRouteMock.mockResolvedValue({
      kind: 'active',
      activeRun: { id: 7, taskId: 'task-1', payload: {} },
    });
    dispatchFollowUpMock.mockImplementation(
      async ({
        route,
        onActive,
        onResume,
      }: {
        route: { kind: string; activeRun?: unknown; completedRun?: unknown };
        onActive?: (run: unknown) => Promise<unknown>;
        onResume?: (
          run: unknown,
        ) => Promise<{ handled: boolean; value?: unknown }>;
      }) => {
        if (route.kind === 'active' && onActive) {
          return { kind: 'active', value: await onActive(route.activeRun) };
        }

        if (route.kind === 'resume' && onResume) {
          const result = await onResume(route.completedRun);

          return result.handled
            ? { kind: 'resume', value: result.value }
            : { kind: 'fresh' };
        }

        return { kind: 'fresh' };
      },
    );
    resolveSlackReactionNamesMock.mockResolvedValue({
      ackEmoji: 'eyes',
      completionEmoji: 'white_check_mark',
    });
    processSnapshotResumeMock.mockResolvedValue(true);
    updateMessageMock.mockResolvedValue(true);
  });

  it('queues the follow-up prompt into the active run and marks the message resolved', async () => {
    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(claimPendingMock).toHaveBeenCalledWith('nonce-1');
    expect(setTrustedRunActingUserMock).toHaveBeenCalledWith({
      runId: 7,
      userId: 'user-1',
    });
    expect(queueSlackMessageMock).toHaveBeenCalledWith(7, {
      text: pendingAction.followUpPrompt,
      user: 'U1',
      userId: 'user-1',
      ts: expect.any(String),
    });
    expect(updateMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '333.444',
      message: {
        blocks: [
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'context',
            elements: [
              expect.objectContaining({
                text: expect.stringContaining('On it'),
              }),
            ],
          }),
          expect.objectContaining({ type: 'context', elements: [] }),
        ],
      },
    });
    expect(postSlackInteractiveResponseMock).not.toHaveBeenCalled();
  });

  it('resumes a slept task from its snapshot with a synthetic thread event', async () => {
    resolveRouteMock.mockResolvedValue({
      kind: 'resume',
      completedRun: { id: 9, snapshotId: 'snap-1' },
    });

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(processSnapshotResumeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        text: pendingAction.followUpPrompt,
        user: 'U1',
      }),
      expect.anything(),
      { id: 9, snapshotId: 'snap-1' },
      '111.222',
      'user-1',
      'eyes',
      'white_check_mark',
      'B1',
    );
    expect(queueSlackMessageMock).not.toHaveBeenCalled();
    expect(updateMessageMock).toHaveBeenCalled();
  });

  it('reports an expired offer without dispatching anything', async () => {
    claimPendingMock.mockResolvedValue(null);

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(queueSlackMessageMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('already handled'),
      }),
    );
  });

  it('asks unlinked users to connect their account without claiming the offer', async () => {
    slackUserMappingsFindFirstMock.mockResolvedValue(undefined);

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(claimPendingMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('connect your Roomote account'),
      }),
    );
  });

  it('reports a dead task when neither an active run nor a snapshot exists', async () => {
    resolveRouteMock.mockResolvedValue({ kind: 'fresh' });

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('no longer be resumed'),
      }),
    );
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});

describe('handleSlackPrReviewActionDismiss', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    claimPendingMock.mockResolvedValue(pendingAction);
    dbSelectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [
            { botAccessToken: 'xoxb-token', botUserId: 'B1' },
          ],
        }),
      }),
    });
    updateMessageMock.mockResolvedValue(true);
  });

  it('claims the offer and notes the dismissal on the message', async () => {
    await handleSlackPrReviewActionDismiss(
      makePayload('pr_review_action_dismiss'),
    );

    expect(claimPendingMock).toHaveBeenCalledWith('nonce-1');
    expect(updateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: '333.444',
        message: {
          blocks: expect.arrayContaining([
            expect.objectContaining({
              elements: [
                expect.objectContaining({
                  text: expect.stringContaining('Dismissed'),
                }),
              ],
            }),
          ]),
        },
      }),
    );
  });

  it('reports an expired offer instead of updating the message', async () => {
    claimPendingMock.mockResolvedValue(null);

    await handleSlackPrReviewActionDismiss(
      makePayload('pr_review_action_dismiss'),
    );

    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('already handled'),
      }),
    );
  });
});
