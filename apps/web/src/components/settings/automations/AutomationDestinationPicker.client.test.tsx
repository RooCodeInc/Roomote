import { render, screen } from '@testing-library/react';

import { AutomationDestinationPicker } from './AutomationDestinationPicker';

const slackOptions = [{ id: 'C123', name: 'general', label: '#general' }];
const discordOptions = [
  { id: 'D123', name: 'updates', label: '#updates · Discord' },
];

describe('AutomationDestinationPicker', () => {
  it('shows the standard provider and DM controls', () => {
    render(
      <AutomationDestinationPicker
        id="destination"
        value={{ provider: 'discord', mode: 'direct_message', channelId: '' }}
        availableProviders={['slack', 'discord', 'teams', 'telegram']}
        slackOptions={slackOptions}
        discordOptions={discordOptions}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Discord');
    expect(
      screen.getByRole('combobox', { name: 'Discord destination type' }),
    ).toHaveTextContent('DM me');
    expect(
      screen.getByText(
        'Results are sent privately to your linked Discord account.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Destination channel' }),
    ).not.toBeInTheDocument();
  });

  it('shows provider-specific channel selection in channel mode', () => {
    render(
      <AutomationDestinationPicker
        id="destination"
        value={{ provider: 'discord', mode: 'channel', channelId: 'D123' }}
        availableProviders={['discord']}
        slackOptions={slackOptions}
        discordOptions={discordOptions}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination channel' }),
    ).toHaveTextContent('#updates · Discord');
  });
});
