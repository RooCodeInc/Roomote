'use client';

import type { CommunicationProvider } from '@roomote/types';

import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

import { SlackChannelSelect } from './SlackChannelSelect';

export type AutomationDestinationProvider = 'none' | CommunicationProvider;
type AutomationDestinationMode = 'channel' | 'direct_message';
type AutomationDestinationValue = {
  provider: AutomationDestinationProvider;
  mode: AutomationDestinationMode;
  channelId: string;
};

type DestinationOption = {
  id: string;
  name: string;
  label: string;
};

const PROVIDER_LABELS = {
  slack: 'Slack',
  discord: 'Discord',
  teams: 'Teams',
  telegram: 'Telegram',
} as const satisfies Record<CommunicationProvider, string>;

export function AutomationDestinationPicker({
  id,
  label = 'Destination',
  value,
  availableProviders,
  slackOptions,
  discordOptions,
  defaultSlackChannelId = '',
  defaultDiscordChannelId = '',
  noneLabel = 'None',
  noneDescription = 'Results appear only in the task view.',
  disabled = false,
  onChange,
}: {
  id: string;
  label?: string;
  value: AutomationDestinationValue;
  availableProviders: readonly CommunicationProvider[];
  slackOptions: DestinationOption[];
  discordOptions: DestinationOption[];
  defaultSlackChannelId?: string;
  defaultDiscordChannelId?: string;
  noneLabel?: string;
  noneDescription?: string;
  disabled?: boolean;
  onChange: (value: AutomationDestinationValue) => void;
}) {
  const visibleProviders = availableProviders.includes(
    value.provider as CommunicationProvider,
  )
    ? availableProviders
    : value.provider === 'none'
      ? availableProviders
      : [...availableProviders, value.provider];
  const providerLabel =
    value.provider === 'none' ? 'Provider' : PROVIDER_LABELS[value.provider];
  const defaultChannelId = (provider: AutomationDestinationProvider) =>
    provider === 'slack'
      ? defaultSlackChannelId
      : provider === 'discord'
        ? defaultDiscordChannelId
        : '';

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="grid gap-2">
        <Select
          value={value.provider}
          disabled={disabled}
          onValueChange={(provider) =>
            onChange({
              provider: provider as AutomationDestinationProvider,
              mode: 'channel',
              channelId: defaultChannelId(
                provider as AutomationDestinationProvider,
              ),
            })
          }
        >
          <SelectTrigger
            id={id}
            aria-label="Destination provider"
            className="w-full sm:max-w-52"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{noneLabel}</SelectItem>
            {visibleProviders.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {PROVIDER_LABELS[provider]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {value.provider === 'none' ? (
          <p className="self-center text-sm text-muted-foreground">
            {noneDescription}
          </p>
        ) : (
          <div className="grid min-w-0 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
            <Select
              value={value.mode}
              disabled={disabled}
              onValueChange={(mode) =>
                onChange({
                  ...value,
                  mode: mode as AutomationDestinationMode,
                  channelId:
                    mode === 'channel' ? defaultChannelId(value.provider) : '',
                })
              }
            >
              <SelectTrigger
                aria-label={`${providerLabel} destination type`}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="channel">Channel</SelectItem>
                <SelectItem value="direct_message">DM me</SelectItem>
              </SelectContent>
            </Select>

            {value.mode === 'direct_message' ? (
              <p className="self-center text-sm text-muted-foreground">
                Results are sent privately to your linked {providerLabel}{' '}
                account.
              </p>
            ) : value.provider === 'slack' ? (
              <SlackChannelSelect
                id={`${id}-channel`}
                className="min-w-0 w-full"
                value={value.channelId || null}
                options={slackOptions}
                disabled={disabled}
                onChange={(channelId) =>
                  onChange({ ...value, channelId: channelId ?? '' })
                }
              />
            ) : value.provider === 'discord' ? (
              <Select
                value={value.channelId || undefined}
                disabled={disabled}
                onValueChange={(channelId) => onChange({ ...value, channelId })}
              >
                <SelectTrigger
                  aria-label="Destination channel"
                  className="min-w-0 w-full"
                >
                  <SelectValue placeholder="Select Discord channel" />
                </SelectTrigger>
                <SelectContent>
                  {discordOptions.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label="Destination channel"
                className="min-w-0 w-full"
                value={value.channelId}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...value, channelId: event.target.value })
                }
                placeholder={
                  value.provider === 'teams'
                    ? 'Teams conversation ID'
                    : 'Telegram chat ID'
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
