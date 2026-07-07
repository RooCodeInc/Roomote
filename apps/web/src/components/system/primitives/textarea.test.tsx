import { render, screen } from '@testing-library/react';

import { Textarea } from './textarea';

describe('Textarea', () => {
  it('keeps an explicit generated minimum height class', () => {
    render(<Textarea aria-label="Prompt" />);

    const textarea = screen.getByLabelText('Prompt');

    expect(textarea.className).toContain('min-h-16');
    expect(textarea.className).not.toContain('min-h-1rem');
  });

  it('opts out of 1Password overlays by default', () => {
    render(<Textarea aria-label="Prompt" />);

    expect(screen.getByLabelText('Prompt')).toHaveAttribute('data-1p-ignore');
    expect(screen.getByLabelText('Prompt')).toHaveAttribute(
      'data-op-ignore',
      'true',
    );
  });
});
