import { render, screen } from '@testing-library/react';

import { DISCORD_INSTALL_PERMISSIONS } from '@/lib/discord-install';

import { ProviderSetupInstructions } from './ProviderSetupInstructions';

describe('ProviderSetupInstructions', () => {
  it('shows the permissions requested by the Discord install link', () => {
    render(
      <ProviderSetupInstructions
        providerId="discord"
        publicOrigin="https://roomote.example"
      />,
    );

    expect(screen.getByText('Installation permissions')).toBeInTheDocument();
    expect(screen.getByText(DISCORD_INSTALL_PERMISSIONS)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Permissions integer' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add to Discord button requests these automatically/),
    ).toBeInTheDocument();
  });
});
