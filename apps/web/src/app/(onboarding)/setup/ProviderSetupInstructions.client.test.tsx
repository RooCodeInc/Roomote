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
      screen.getByText(
        /View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Create Public Threads, Send Messages in Threads, Add Reactions, and Manage Threads/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Manage Threads is only required for required-tag forums that expose only moderated tags/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add to Discord button appears and requests these/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Permissions integer')).not.toBeInTheDocument();
    expect(screen.queryByText('309237763136')).not.toBeInTheDocument();
    expect(screen.queryByText('326417632320')).not.toBeInTheDocument();
  });
});
