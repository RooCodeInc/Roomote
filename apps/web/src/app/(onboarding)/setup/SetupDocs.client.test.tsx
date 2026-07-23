import { fireEvent, render, screen } from '@testing-library/react';

import { getSetupDocsStep, getSetupDocsUrl, SetupDocs } from './SetupDocs';

describe('SetupDocs', () => {
  it('maps setup steps to the matching documentation pages', () => {
    expect(getSetupDocsUrl('auth-provider')).toBe(
      'https://docs.roomote.dev/communications',
    );
    expect(getSetupDocsUrl('repo-selection')).toBe(
      'https://docs.roomote.dev/environments',
    );
    expect(getSetupDocsStep('email-account')).toBe('email-account');
    expect(getSetupDocsStep(null)).toBe('welcome');
  });

  it('opens and closes the desktop documentation frame', () => {
    render(<SetupDocs step="compute-config" />);

    expect(
      screen.queryByTitle('Roomote setup documentation'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show docs' }));

    expect(screen.getByTitle('Roomote setup documentation')).toHaveAttribute(
      'src',
      'https://docs.roomote.dev/compute',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close docs' }));

    expect(
      screen.queryByTitle('Roomote setup documentation'),
    ).not.toBeInTheDocument();
  });
});
