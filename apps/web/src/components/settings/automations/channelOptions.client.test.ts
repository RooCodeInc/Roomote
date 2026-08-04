import { describe, expect, it } from 'vitest';

import {
  buildAutomationDiscordDestinationOptions,
  buildManagerSlackChannelOptions,
  DISCORD_DESTINATION_OPTION_PREFIX,
  formatSlackChannelValue,
  isManagerChannelSelectionDisabled,
  shouldShowManagerSlackChannelWarning,
} from './channelOptions';

describe('manager channel options', () => {
  it('shows saved access warnings but ignores stale warnings during edits', () => {
    expect(
      shouldShowManagerSlackChannelWarning({
        formValue: '#roomote-managers',
        savedChannelId: 'C123MANAGER',
        warningChannelId: 'C123MANAGER',
        isDirty: false,
      }),
    ).toBe(true);
    expect(
      shouldShowManagerSlackChannelWarning({
        formValue: '#other-channel',
        savedChannelId: 'C123MANAGER',
        warningChannelId: 'C123MANAGER',
        isDirty: true,
      }),
    ).toBe(false);
  });

  it('formats Slack channel names and ids for display', () => {
    expect(formatSlackChannelValue('roomote-managers')).toBe(
      '#roomote-managers',
    );
    expect(formatSlackChannelValue('#roomote-managers')).toBe(
      '#roomote-managers',
    );
    expect(formatSlackChannelValue('C123MANAGER')).toBe('C123MANAGER');
  });

  it('preserves missing selections without duplicating fetched options', () => {
    expect(
      buildManagerSlackChannelOptions({
        channels: [{ id: 'C456', name: 'engineering' }],
        selectedValue: '#roomote-managers',
      }),
    ).toEqual([
      {
        id: '#roomote-managers',
        name: 'roomote-managers',
        label: '#roomote-managers',
      },
      { id: 'C456', name: 'engineering', label: '#engineering' },
    ]);
    expect(
      buildManagerSlackChannelOptions({
        channels: [{ id: 'C123MANAGER', name: 'roomote-managers' }],
        selectedValue: '#roomote-managers',
      }),
    ).toHaveLength(1);
  });

  it('prefixes Discord options and preserves missing saved channels', () => {
    expect(
      buildAutomationDiscordDestinationOptions({
        channels: [{ id: '111', name: 'general', label: '#general' }],
        selectedChannelId: '222',
        includeProviderSuffix: true,
      }),
    ).toEqual([
      {
        id: `${DISCORD_DESTINATION_OPTION_PREFIX}222`,
        name: '222',
        label: '#222 (Discord)',
      },
      {
        id: `${DISCORD_DESTINATION_OPTION_PREFIX}111`,
        name: 'general',
        label: '#general (Discord)',
      },
    ]);
  });

  it('omits the Discord suffix when no other provider needs disambiguation', () => {
    expect(
      buildAutomationDiscordDestinationOptions({
        channels: [{ id: '111', name: 'general', label: '#general' }],
        selectedChannelId: '111',
        includeProviderSuffix: false,
      }),
    ).toEqual([
      {
        id: `${DISCORD_DESTINATION_OPTION_PREFIX}111`,
        name: 'general',
        label: '#general',
      },
    ]);
  });

  it('allows configured values when the provider is disconnected', () => {
    expect(
      isManagerChannelSelectionDisabled({
        slackConnected: false,
        isFetching: false,
        hasValue: true,
        isConfigured: true,
      }),
    ).toBe(false);
    expect(
      isManagerChannelSelectionDisabled({
        slackConnected: false,
        isFetching: false,
        hasValue: false,
        isConfigured: false,
      }),
    ).toBe(true);
  });
});
