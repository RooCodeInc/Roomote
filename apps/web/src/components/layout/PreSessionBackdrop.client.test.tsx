import { render, screen } from '@testing-library/react';

import { PreSessionBackdrop } from './PreSessionBackdrop';

describe('PreSessionBackdrop', () => {
  it('keeps the product preview decorative and the foreground interactive', () => {
    render(
      <PreSessionBackdrop>
        <button type="button">Continue setup</button>
      </PreSessionBackdrop>,
    );

    const preview = document.querySelector(
      '[data-slot="pre-session-product-preview"]',
    );

    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview).toHaveAttribute('inert');
    expect(
      screen.getByRole('button', { name: 'Continue setup' }),
    ).toBeEnabled();
  });
});
