import {
  buildResolvedSlackPrReviewMessageBlocks,
  buildSlackPrReviewActionBlocks,
} from '../pr-review-action';

describe('PR review action blocks', () => {
  it('renders the review summary as modern Slack markdown', () => {
    const blocks = buildSlackPrReviewActionBlocks({
      text: 'Review [PR #42](https://github.com/owner/repo/pull/42)',
      question: 'Should I resolve these?',
      nonce: 'nonce-1',
    });

    expect(blocks[0]).toEqual({
      type: 'markdown',
      text: 'Review [PR #42](https://github.com/owner/repo/pull/42)',
    });
  });

  it('uses neutral styling for every response button', () => {
    const blocks = buildSlackPrReviewActionBlocks({
      text: 'Review summary',
      question: 'Should I resolve these?',
      nonce: 'nonce-1',
    });
    const actions = blocks.find((block) => block.type === 'actions');

    if (!actions || actions.type !== 'actions') {
      throw new Error('Expected actions block');
    }

    expect(actions).toMatchObject({
      elements: [
        { action_id: 'pr_review_action_yes' },
        { action_id: 'pr_review_action_auto' },
        { action_id: 'pr_review_action_dismiss' },
      ],
    });
    expect(actions.elements?.every((element) => !('style' in element))).toBe(
      true,
    );
  });

  it('renders a resolution as an italicized context note', () => {
    expect(
      buildResolvedSlackPrReviewMessageBlocks(
        [{ type: 'actions', block_id: 'pr_review_action', elements: [] }],
        'Resolution',
      ),
    ).toEqual([
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Resolution_' }],
      },
    ]);
  });
});
