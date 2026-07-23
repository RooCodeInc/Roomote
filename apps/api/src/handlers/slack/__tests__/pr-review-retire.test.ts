const { claimForThreadMock, getMessageBlocksMock, updateMessageMock } =
  vi.hoisted(() => ({
    claimForThreadMock: vi.fn(),
    getMessageBlocksMock: vi.fn(),
    updateMessageMock: vi.fn(),
  }));

vi.mock('@roomote/sdk/server', () => ({
  claimPendingPrReviewActionsForThread: claimForThreadMock,
}));

import type { SlackNotifier } from '@roomote/slack';

import { retireSlackPrReviewOffersBestEffort } from '../pr-review-retire.js';

const slack = {
  getMessageBlocks: getMessageBlocksMock,
  updateMessage: updateMessageMock,
} as unknown as SlackNotifier;

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  getMessageBlocksMock.mockResolvedValue([
    { type: 'section', text: { type: 'mrkdwn', text: 'summary' } },
    {
      type: 'section',
      block_id: 'pr_review_action_question',
      text: { type: 'mrkdwn', text: 'Want me to take a look?' },
    },
    { type: 'actions', block_id: 'pr_review_action', elements: [] },
    { type: 'context', elements: [] },
  ]);
  updateMessageMock.mockResolvedValue(true);
});

describe('retireSlackPrReviewOffersBestEffort', () => {
  it('claims every offer in the thread and strips the buttons from each posted message', async () => {
    claimForThreadMock.mockResolvedValue([
      { nonce: 'n1', messageId: '111.111' },
      { nonce: 'n2', messageId: '222.222' },
    ]);

    retireSlackPrReviewOffersBestEffort({
      slack,
      channelId: 'C123',
      threadTs: '100.000',
    });
    await flushAsync();

    expect(claimForThreadMock).toHaveBeenCalledWith({
      provider: 'slack',
      channelId: 'C123',
      threadId: '100.000',
    });
    expect(updateMessageMock).toHaveBeenCalledTimes(2);
    const firstUpdate = updateMessageMock.mock.calls[0]?.[0];
    expect(firstUpdate.ts).toBe('111.111');
    const blocks = firstUpdate.message.blocks as Array<Record<string, unknown>>;
    // Question and buttons are gone; a resolution note stands in their place.
    expect(
      blocks.some(
        (block) =>
          block.block_id === 'pr_review_action' ||
          block.block_id === 'pr_review_action_question',
      ),
    ).toBe(false);
    expect(JSON.stringify(blocks)).toContain(
      'Answered with a reply in the thread.',
    );
  });

  it('skips message edits for offers that never recorded a posted message', async () => {
    claimForThreadMock.mockResolvedValue([{ nonce: 'n1', messageId: null }]);

    retireSlackPrReviewOffersBestEffort({
      slack,
      channelId: 'C123',
      threadTs: '100.000',
    });
    await flushAsync();

    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('does nothing when the thread has no pending offers', async () => {
    claimForThreadMock.mockResolvedValue([]);

    retireSlackPrReviewOffersBestEffort({
      slack,
      channelId: 'C123',
      threadTs: '100.000',
    });
    await flushAsync();

    expect(getMessageBlocksMock).not.toHaveBeenCalled();
    expect(updateMessageMock).not.toHaveBeenCalled();
  });
});
