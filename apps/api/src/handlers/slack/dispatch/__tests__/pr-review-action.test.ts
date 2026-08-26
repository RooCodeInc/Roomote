import type { SlackInteractivePayload } from '@roomote/slack';

const {
  claimPendingMock,
  dispatchFollowUpMock,
  enableAutoHandleMock,
  completeActionDispatchMock,
  postSlackInteractiveResponseMock,
  slackUserMappingsFindFirstMock,
  dbSelectMock,
  updateMessageMock,
} = vi.hoisted(() => ({
  claimPendingMock: vi.fn(),
  dispatchFollowUpMock: vi.fn(),
  enableAutoHandleMock: vi.fn(),
  completeActionDispatchMock: vi.fn(),
  postSlackInteractiveResponseMock: vi.fn(),
  slackUserMappingsFindFirstMock: vi.fn(),
  dbSelectMock: vi.fn(),
  updateMessageMock: vi.fn(),
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/slack')>();

  class MockSlackNotifier {
    updateMessage = updateMessageMock;
  }

  return {
    ...original,
    postSlackInteractiveResponse: postSlackInteractiveResponseMock,
    SlackNotifier: MockSlackNotifier,
  };
});

vi.mock('@roomote/sdk/server', () => ({
  claimPendingPrReviewAction: claimPendingMock,
  dispatchPrReviewFollowUp: dispatchFollowUpMock,
  enableAutoHandlePrReviewFeedback: enableAutoHandleMock,
  completePendingPrReviewActionDispatch: completeActionDispatchMock,
}));

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
  slackInstallations: { teamId: 'teamId' },
  slackUserMappings: { slackUserId: 'slackUserId', slackTeamId: 'slackTeamId' },
}));

import {
  handleSlackPrReviewActionAuto,
  handleSlackPrReviewActionDismiss,
  handleSlackPrReviewActionYes,
} from '../pr-review-action.js';

const pendingAction = {
  nonce: 'nonce-1',
  provider: 'slack' as const,
  slackTeamId: 'T1',
  taskId: 'task-1',
  repository: 'owner/repo',
  prNumber: 42,
  prUrl: 'https://github.com/owner/repo/pull/42',
  channelId: 'C123',
  threadId: '111.222',
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

beforeEach(() => {
  vi.clearAllMocks();

  slackUserMappingsFindFirstMock.mockResolvedValue({ userId: 'user-1' });
  claimPendingMock.mockResolvedValue(pendingAction);
  dispatchFollowUpMock.mockResolvedValue({ outcome: 'queued', runId: 7 });
  dbSelectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ botAccessToken: 'xoxb-token', botUserId: 'B1' }],
      }),
    }),
  });
  updateMessageMock.mockResolvedValue(true);
});

describe('handleSlackPrReviewActionYes', () => {
  it('claims the offer, dispatches the follow-up, and marks the message resolved', async () => {
    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(claimPendingMock).toHaveBeenCalledWith('nonce-1', {
      expectedSlackTeamId: 'T1',
      choice: 'yes',
      actingUserId: 'user-1',
    });
    expect(enableAutoHandleMock).not.toHaveBeenCalled();
    expect(dispatchFollowUpMock).toHaveBeenCalledWith({
      provider: 'slack',
      taskId: 'task-1',
      slackTeamId: 'T1',
      channelId: 'C123',
      threadId: '111.222',
      followUpPrompt: pendingAction.followUpPrompt,
      actingUserId: 'user-1',
      providerUserId: 'U1',
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

  it('fails closed when a button is delivered by another workspace', async () => {
    claimPendingMock.mockResolvedValue(null);

    await handleSlackPrReviewActionYes({
      ...makePayload('pr_review_action_yes'),
      team: { id: 'T2', domain: 'other' },
    });

    expect(dispatchFollowUpMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({ text: expect.stringContaining('expired') }),
    );
  });

  it('dispatches a verified legacy offer using only its immutable task binding', async () => {
    claimPendingMock.mockResolvedValue({
      ...pendingAction,
      slackTeamId: undefined,
    });

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(dispatchFollowUpMock).toHaveBeenCalledWith({
      provider: 'slack',
      taskId: 'task-1',
      channelId: 'C123',
      threadId: '111.222',
      followUpPrompt: pendingAction.followUpPrompt,
      actingUserId: 'user-1',
      providerUserId: 'U1',
    });
  });

  it('reports an expired offer without dispatching anything', async () => {
    claimPendingMock.mockResolvedValue(null);

    await handleSlackPrReviewActionYes(makePayload('pr_review_action_yes'));

    expect(dispatchFollowUpMock).not.toHaveBeenCalled();
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

  it('reports a dead task when the dispatch is unavailable', async () => {
    dispatchFollowUpMock.mockResolvedValue({ outcome: 'unavailable' });

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

describe('handleSlackPrReviewActionAuto', () => {
  it('enables auto-handling, dispatches, and notes the standing behavior', async () => {
    await handleSlackPrReviewActionAuto(makePayload('pr_review_action_auto'));

    expect(enableAutoHandleMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      userId: 'user-1',
    });
    expect(dispatchFollowUpMock).toHaveBeenCalled();
    expect(updateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'OK, <@U1>. Future review feedback on this PR will get resolved automatically.',
              },
            }),
          ]),
        },
      }),
    );
  });

  it('keeps auto-handling enabled even when the current dispatch is unavailable', async () => {
    dispatchFollowUpMock.mockResolvedValue({ outcome: 'unavailable' });

    await handleSlackPrReviewActionAuto(makePayload('pr_review_action_auto'));

    expect(enableAutoHandleMock).toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('resolve future feedback'),
      }),
    );
    // The message still resolves to the auto-handling note.
    expect(updateMessageMock).toHaveBeenCalled();
  });

  it('does not promise auto-resolution when the preference was not persisted', async () => {
    enableAutoHandleMock.mockRejectedValue(
      new Error('linked pull request was not found'),
    );

    await handleSlackPrReviewActionAuto(makePayload('pr_review_action_auto'));

    expect(dispatchFollowUpMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
    expect(postSlackInteractiveResponseMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/response',
      expect.objectContaining({
        text: expect.stringContaining('Failed to start the follow-up'),
      }),
    );
  });
});

describe('handleSlackPrReviewActionDismiss', () => {
  it('claims the offer and notes the dismissal on the message', async () => {
    await handleSlackPrReviewActionDismiss(
      makePayload('pr_review_action_dismiss'),
    );

    expect(claimPendingMock).toHaveBeenCalledWith('nonce-1', {
      expectedSlackTeamId: 'T1',
      choice: 'dismiss',
    });
    expect(dispatchFollowUpMock).not.toHaveBeenCalled();
    expect(updateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
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
