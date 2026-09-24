import { render, screen } from '@testing-library/react';

import { PullRequestBadge } from './PullRequestBadge';

describe('PullRequestBadge', () => {
  it('uses the repository name and PR number for linked associations', () => {
    render(
      <PullRequestBadge
        repo="RooCodeInc/Roomote"
        prNumber={123}
        url="https://github.com/RooCodeInc/Roomote/pull/123"
        size="xs"
      />,
    );

    const link = screen.getByRole('link', { name: 'Roomote#123' });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/RooCodeInc/Roomote/pull/123',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.querySelector('svg')).toBeInTheDocument();
  });

  it('falls back to the pull request title when association details are missing', () => {
    render(
      <PullRequestBadge
        url="https://github.com/RooCodeInc/Roomote/pull/123"
        title="Update downstream dependencies"
        size="xs"
      />,
    );

    expect(
      screen.getByRole('link', {
        name: 'Update downstream dependencies',
      }),
    ).toHaveAttribute('href', 'https://github.com/RooCodeInc/Roomote/pull/123');
  });
});
