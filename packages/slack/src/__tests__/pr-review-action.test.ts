import {
  buildResolvedSlackPrReviewMessageBlocks,
  buildSlackPrReviewActionBlocks,
} from '../pr-review-action';

describe('PR review action blocks', () => {
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

  it('can render a resolution as a regular message', () => {
    expect(
      buildResolvedSlackPrReviewMessageBlocks(
        [{ type: 'actions', block_id: 'pr_review_action', elements: [] }],
        'Resolution',
        'section',
      ),
    ).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Resolution' },
      },
    ]);
  });
});
