import { render, screen } from '@testing-library/react';

import { ProviderSetupInstructions } from './ProviderSetupInstructions';

describe('ProviderSetupInstructions', () => {
  it('explains Discord install permissions and that Add to Discord appears after save', () => {
    render(
      <ProviderSetupInstructions
        providerId="discord"
        publicOrigin="https://roomote.example"
      />,
    );

    expect(screen.getByText('Installation permissions')).toBeInTheDocument();
    expect(
      screen.getByText(/Add to Discord button appears and requests these/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Permissions integer')).not.toBeInTheDocument();
    expect(screen.queryByText('309237763136')).not.toBeInTheDocument();
  });
});
