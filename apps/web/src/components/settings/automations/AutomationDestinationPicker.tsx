'use client';

import { useRef } from 'react';
import type { AutomationDestinationProvider as DestinationProvider } from '@roomote/types';

import {
  Input,
  Label,
  Select,
  SelectContent,
  type SelectHandoffTarget,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

import { SlackChannelSelect } from './SlackChannelSelect';

export type AutomationDestinationProvider = 'none' | DestinationProvider;
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
  email: 'Email',
} as const satisfies Record<DestinationProvider, string>;

export function AutomationDestinationPicker({
  id,
  label = 'Destination',
  value,
  availableProviders,
  slackOptions,
  discordOptions,
  emailOptions = [],
  channelCatalogAvailable = true,
  defaultSlackChannelId = '',
  defaultDiscordChannelId = '',
  defaultEmailIdentityId = '',
  noneLabel = 'None',
  noneDescription = 'Results appear only in the task view.',
  disabled = false,
  allowNone = true,
  allowDirectMessage = true,
  onChange,
}: {
  id: string;
  label?: string;
  value: AutomationDestinationValue;
  availableProviders: readonly DestinationProvider[];
  slackOptions: DestinationOption[];
  discordOptions: DestinationOption[];
  emailOptions?: DestinationOption[];
  channelCatalogAvailable?: boolean;
  defaultSlackChannelId?: string;
  defaultDiscordChannelId?: string;
  defaultEmailIdentityId?: string;
  noneLabel?: string;
  noneDescription?: string;
  disabled?: boolean;
  allowNone?: boolean;
  allowDirectMessage?: boolean;
  onChange: (value: AutomationDestinationValue) => void;
}) {
  const nextDestinationRef = useRef<
    HTMLInputElement | SelectHandoffTarget | null
  >(null);
  const visibleProviders = availableProviders.includes(
    value.provider as DestinationProvider,
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
        : provider === 'email'
          ? defaultEmailIdentityId
          : '';

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="grid gap-2">
        <Select
          value={value.provider}
          disabled={disabled}
          handoffTargetOnSelect={nextDestinationRef}
          onValueChange={(provider) =>
            onChange({
              provider: provider as AutomationDestinationProvider,
              mode: provider === 'email' ? 'direct_message' : 'channel',
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
            {allowNone ? (
              <SelectItem value="none">{noneLabel}</SelectItem>
            ) : null}
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
          <div
            className={
              allowDirectMessage && value.provider !== 'email'
                ? 'grid min-w-0 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center'
                : 'grid min-w-0 gap-2'
            }
          >
            {allowDirectMessage && value.provider !== 'email' ? (
              <Select
                value={value.mode}
                disabled={disabled}
                handoffTargetOnSelect={nextDestinationRef}
                onValueChange={(mode) =>
                  onChange({
                    ...value,
                    mode: mode as AutomationDestinationMode,
                    channelId:
                      mode === 'channel'
                        ? defaultChannelId(value.provider)
                        : '',
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
            ) : null}

            {value.provider === 'email' ? (
              <div className="grid gap-2">
                <Select
                  handoffRef={
                    value.channelId || emailOptions.length === 0
                      ? undefined
                      : (target) => {
                          nextDestinationRef.current = target;
                        }
                  }
                  value={value.channelId}
                  disabled={disabled}
                  onValueChange={(identityId) =>
                    onChange({ ...value, channelId: identityId })
                  }
                >
                  <SelectTrigger
                    aria-label="Email address"
                    className="min-w-0 w-full sm:max-w-96"
                  >
                    <SelectValue placeholder="Select Email address" />
                  </SelectTrigger>
                  <SelectContent>
                    {emailOptions.map((identity) => (
                      <SelectItem key={identity.id} value={identity.id}>
                        {identity.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  Reports use only this selected identity and stop if it is no
                  longer eligible.
                </p>
              </div>
            ) : value.mode === 'direct_message' ? (
              <p className="self-center text-sm text-muted-foreground">
                Results are sent privately to your linked {providerLabel}{' '}
                account.
              </p>
            ) : value.provider === 'slack' && channelCatalogAvailable ? (
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
            ) : value.provider === 'discord' && channelCatalogAvailable ? (
              <Select
                handoffRef={
                  value.channelId || discordOptions.length === 0
                    ? undefined
                    : (target) => {
                        nextDestinationRef.current = target;
                      }
                }
                value={value.channelId}
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
                ref={
                  value.channelId
                    ? undefined
                    : (target) => {
                        nextDestinationRef.current = target;
                      }
                }
                aria-label="Destination channel"
                className="min-w-0 w-full"
                value={value.channelId}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...value, channelId: event.target.value })
                }
                placeholder={
                  value.provider === 'slack'
                    ? 'Slack channel ID'
                    : value.provider === 'discord'
                      ? 'Discord channel ID'
                      : value.provider === 'teams'
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
