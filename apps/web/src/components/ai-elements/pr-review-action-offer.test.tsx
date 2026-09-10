import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PrReviewActionOffer } from './pr-review-action-offer';

const offer = {
  deliveryId: '11111111-1111-4111-8111-111111111111',
  question: 'Would you like me to resolve these issues?',
  status: 'pending' as const,
};

describe('PrReviewActionOffer', () => {
  it('shows actions without a resolving question and hides them when superseded', () => {
    const onAction = vi.fn();
    const { container, rerender } = render(
      <PrReviewActionOffer offer={offer} onAction={onAction} />,
    );

    expect(screen.queryByText(offer.question)).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['Resolve these issues', 'Auto-resolve on this PR', 'Dismiss']);
    expect(onAction).not.toHaveBeenCalled();

    rerender(
      <PrReviewActionOffer
        offer={{ ...offer, status: 'dismissed' }}
        onAction={onAction}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not render an offer with dismissed state', () => {
    const { container } = render(
      <PrReviewActionOffer
        offer={{ ...offer, status: 'dismissed' }}
        onAction={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('removes the offer container after dismissal', async () => {
    const onAction = vi.fn().mockResolvedValue('dismissed');
    render(<PrReviewActionOffer offer={offer} onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(
        screen.queryByTestId('pr-review-action-offer'),
      ).not.toBeInTheDocument();
    });
    expect(onAction).toHaveBeenCalledWith('dismiss');
  });
});
