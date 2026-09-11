import { fireEvent, render, screen } from '@testing-library/react';

import { AutomationDestinationPicker } from './AutomationDestinationPicker';

const slackOptions = [{ id: 'C123', name: 'general', label: '#general' }];
const discordOptions = [
  { id: 'D123', name: 'updates', label: '#updates · Discord' },
];

describe('AutomationDestinationPicker', () => {
  it.each(['slack', 'discord'] as const)(
    'preserves and edits known %s channel IDs without a catalog',
    (provider) => {
      const onChange = vi.fn();
      render(
        <AutomationDestinationPicker
          id="destination"
          value={{ provider, mode: 'channel', channelId: 'saved-channel' }}
          availableProviders={[provider]}
          slackOptions={slackOptions}
          discordOptions={discordOptions}
          channelCatalogAvailable={false}
          onChange={onChange}
        />,
      );
      const input = screen.getByRole('textbox', {
        name: 'Destination channel',
      });
      expect(input).toHaveValue('saved-channel');
      expect(screen.queryByText('#general')).not.toBeInTheDocument();
      expect(screen.queryByText('#updates · Discord')).not.toBeInTheDocument();
      fireEvent.change(input, { target: { value: 'known-channel' } });
      expect(onChange).toHaveBeenCalledWith({
        provider,
        mode: 'channel',
        channelId: 'known-channel',
      });
    },
  );
  it('shows the standard provider and DM controls', () => {
    render(
      <AutomationDestinationPicker
        id="destination"
        value={{ provider: 'discord', mode: 'direct_message', channelId: '' }}
        availableProviders={['slack', 'discord', 'teams', 'telegram']}
        slackOptions={slackOptions}
        discordOptions={discordOptions}
        channelCatalogAvailable={false}
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

  it('shows Email without any address or channel input', () => {
    const onChange = vi.fn();
    render(
      <AutomationDestinationPicker
        id="destination"
        value={{
          provider: 'email',
          mode: 'direct_message',
          channelId: 'verified:user-1:abc',
        }}
        availableProviders={['email']}
        slackOptions={slackOptions}
        discordOptions={discordOptions}
        emailOptions={[
          {
            id: 'verified:user-1:abc',
            name: 'owner@example.com',
            label: 'owner@example.com · Verified',
          },
        ]}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Destination provider' }),
    ).toHaveTextContent('Email');
    expect(
      screen.getByText(
        'Reports use only this selected identity and stop if it is no longer eligible.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Email address' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Email address' }),
    ).toHaveTextContent('owner@example.com · Verified');
  });
});
