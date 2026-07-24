import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { SetupDocs } from './SetupDocs';
import { getSetupDocsPath, getSetupDocsStep } from './setup-docs';

describe('SetupDocs', () => {
  it('maps setup steps to the matching documentation pages', () => {
    expect(getSetupDocsPath('auth-provider')).toBe('communications');
    expect(getSetupDocsPath('repo-selection')).toBe('environments');
    expect(getSetupDocsStep('email-account')).toBe('email-account');
    expect(getSetupDocsStep(null)).toBe('welcome');
  });

  it('opens and closes the desktop documentation frame', () => {
    function SetupDocsHarness() {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <SetupDocs isOpen={isOpen} onOpenChange={setIsOpen}>
          <p>Docs content</p>
        </SetupDocs>
      );
    }

    render(<SetupDocsHarness />);

    expect(screen.queryByText('Docs content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));

    expect(screen.getByText('Docs content')).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Open this documentation page in a new tab',
      }),
    ).toHaveAttribute('href', 'https://docs.roomote.dev/index');

    fireEvent.click(screen.getByRole('button', { name: 'Close docs' }));

    expect(screen.queryByText('Docs content')).not.toBeInTheDocument();
  });
});
