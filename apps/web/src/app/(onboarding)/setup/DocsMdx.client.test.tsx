import { render, screen } from '@testing-library/react';

import { docsMdxComponents } from './DocsMdx';

describe('docsMdxComponents', () => {
  it('opens documentation links in a new tab', () => {
    const DocsLink = docsMdxComponents.a;

    render(
      <DocsLink href="/self-hosting" target="_blank">
        Self-hosting
      </DocsLink>,
    );

    const link = screen.getByRole('link', { name: 'Self-hosting' });
    expect(link).toHaveAttribute(
      'href',
      'https://docs.roomote.dev/self-hosting',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
