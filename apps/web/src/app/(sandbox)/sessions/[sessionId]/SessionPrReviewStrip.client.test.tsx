import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionPrReviewStrip } from './SessionPrReviewStrip';
import type { SessionReview } from './session-pr-reviews';

function review(number: number): SessionReview {
  return {
    key: `pr-${number}`,
    revision: `feedback-${number}`,
    review: {
      url: `https://github.com/example/project/pull/${number}`,
      repository: 'example/project',
      number,
      summary: `Feedback for ${number}`,
      findingCount: 1,
      status: 'feedback',
    },
    offer: {
      deliveryId: `delivery-${number}`,
      question: 'Resolve?',
      status: 'pending',
    },
  };
}

it('keeps multiple PRs compact and expands one set of actions at a time', () => {
  render(
    <SessionPrReviewStrip
      reviews={[review(42), review(43)]}
      onAction={vi.fn()}
    />,
  );
  expect(screen.getAllByRole('button', { name: 'Fix finding' })).toHaveLength(
    1,
  );
  expect(screen.getByText('Feedback for 43')).toBeInTheDocument();
  expect(screen.queryByText('Feedback for 42')).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Review details for PR #42' }),
  );
  expect(screen.getByText('Feedback for 42')).toBeInTheDocument();
  expect(screen.queryByText('Feedback for 43')).not.toBeInTheDocument();
  expect(
    within(
      screen.getByRole('region', { name: 'Review of example/project PR #42' }),
    ).getByRole('button', { name: 'Fix finding' }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Review details for PR #42' }),
  );
  expect(
    screen.queryByRole('button', { name: 'Fix finding' }),
  ).not.toBeInTheDocument();
});
