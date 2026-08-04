import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  Alert,
  AlertDescription,
  Button,
  Check,
  Input,
  Label,
  RefreshCcw,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  Spinner,
  SquarePen,
  TriangleAlert,
} from '@/components/system';

import {
  buildAutomationDiscordDestinationOptions,
  buildManagerSlackChannelOptions,
  DISCORD_DESTINATION_OPTION_PREFIX,
  formatSlackChannelValue,
  isManagerChannelSelectionDisabled,
  matchesSlackChannelOption,
  shouldShowManagerSlackChannelWarning,
} from './channelOptions';

const CUSTOM_MANAGER_CHANNEL_SELECT_VALUE = '__custom_manager_channel__';
const CLEAR_MANAGER_CHANNEL_SELECT_VALUE = '__clear_manager_channel__';

type SlackChannel = { id: string; name: string };
type DiscordChannel = { id: string; name: string; label: string };

type ManagerChannelValue = {
  slackChannel: string;
  discordChannel: string;
};

export function ManagerChannelEditor({
  value,
  savedSlackChannel,
  savedSlackChannelId,
  savedDiscordChannelId,
  slackChannels,
  discordChannels,
  slackConnected,
  discordConnected,
  channelsPending,
  channelsFetching,
  channelsError,
  isDirty,
  isSaving,
  warningChannelId,
  slackAppMention,
  fieldError,
  showMigrationNote,
  onChange,
  onRefresh,
  onSave,
  onReset,
}: {
  value: ManagerChannelValue;
  savedSlackChannel: string;
  savedSlackChannelId: string | null;
  savedDiscordChannelId: string | null;
  slackChannels: SlackChannel[];
  discordChannels: DiscordChannel[];
  slackConnected: boolean;
  discordConnected: boolean;
  channelsPending: boolean;
  channelsFetching: boolean;
  channelsError: boolean;
  isDirty: boolean;
  isSaving: boolean;
  warningChannelId: string | null;
  slackAppMention: string;
  fieldError?: string;
  showMigrationNote: boolean;
  onChange: (value: ManagerChannelValue) => void;
  onRefresh: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isEnteringCustomChannel, setIsEnteringCustomChannel] = useState(false);
  const wasSaving = useRef(false);

  const configured = Boolean(savedSlackChannelId || savedDiscordChannelId);
  const hasValue = Boolean(
    value.slackChannel.trim() || value.discordChannel.trim(),
  );
  const slackOptions = useMemo(
    () =>
      buildManagerSlackChannelOptions({
        channels: slackChannels,
        selectedValue: null,
      }),
    [slackChannels],
  );
  const selectedSlackOption =
    slackOptions.find((option) =>
      matchesSlackChannelOption(value.slackChannel, option),
    ) ?? null;
  const discordOptions = useMemo(
    () =>
      buildAutomationDiscordDestinationOptions({
        channels: discordChannels,
        selectedChannelId: value.discordChannel,
        includeProviderSuffix: slackConnected,
      }),
    [discordChannels, slackConnected, value.discordChannel],
  );
  const selectedDiscordOption =
    discordOptions.find(
      (option) =>
        option.id ===
        `${DISCORD_DESTINATION_OPTION_PREFIX}${value.discordChannel}`,
    ) ?? null;
  const showCustomInput =
    isEnteringCustomChannel ||
    (hasValue && !selectedSlackOption && !selectedDiscordOption);
  const selectionDisabled = isManagerChannelSelectionDisabled({
    slackConnected: slackConnected || discordConnected,
    isFetching: channelsFetching,
    hasValue,
    isConfigured: configured,
  });
  const selectLabel = showCustomInput
    ? formatSlackChannelValue(value.slackChannel) || 'Private or manual channel'
    : selectedDiscordOption?.label ||
      selectedSlackOption?.label ||
      (discordConnected ? 'Select a channel' : 'Select a Slack channel');
  const selectValue = showCustomInput
    ? CUSTOM_MANAGER_CHANNEL_SELECT_VALUE
    : (selectedDiscordOption?.id ?? selectedSlackOption?.id);
  const showWarning = shouldShowManagerSlackChannelWarning({
    formValue: value.slackChannel,
    savedChannelId: savedSlackChannelId,
    warningChannelId,
    isDirty,
  });
  const savedLabel = getSavedManagerChannelLabel({
    savedSlackChannel,
    savedSlackChannelId,
    savedDiscordChannelId,
    slackChannels,
    discordChannels,
  });
  const showForm = !configured || isEditing || isDirty;

  useEffect(() => {
    if (wasSaving.current && !isSaving && !isDirty && configured) {
      setIsEditing(false);
      setIsEnteringCustomChannel(false);
    }
    wasSaving.current = isSaving;
  }, [configured, isDirty, isSaving]);

  if (!showForm) {
    return (
      <p className="text-sm text-muted-foreground">
        Posting manager-facing updates to{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 align-baseline text-sm font-normal"
          onClick={() => setIsEditing(true)}
        >
          {savedLabel}
          <SquarePen className="size-3.5" />
        </Button>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="manager-channel">
        Where should Roomote post manager-facing updates?
      </Label>
      <p className="text-sm text-muted-foreground">
        Make sure the Roomote app is added to the channel.
      </p>
      <div className="max-w-md space-y-2">
        <div className="flex items-center gap-2">
          <Select
            value={selectValue}
            onValueChange={(nextValue) => {
              if (nextValue === CLEAR_MANAGER_CHANNEL_SELECT_VALUE) {
                setIsEnteringCustomChannel(false);
                onChange({ slackChannel: '', discordChannel: '' });
                return;
              }

              if (nextValue === CUSTOM_MANAGER_CHANNEL_SELECT_VALUE) {
                setIsEnteringCustomChannel(true);
                if (selectedSlackOption) {
                  onChange({ slackChannel: '', discordChannel: '' });
                }
                return;
              }

              if (nextValue.startsWith(DISCORD_DESTINATION_OPTION_PREFIX)) {
                setIsEnteringCustomChannel(false);
                onChange({
                  slackChannel: '',
                  discordChannel: nextValue.slice(
                    DISCORD_DESTINATION_OPTION_PREFIX.length,
                  ),
                });
                return;
              }

              const selectedChannel = slackOptions.find(
                (channel) => channel.id === nextValue,
              );
              if (selectedChannel) {
                setIsEnteringCustomChannel(false);
                onChange({
                  slackChannel: selectedChannel.label,
                  discordChannel: '',
                });
              }
            }}
            disabled={selectionDisabled}
          >
            <SelectTrigger
              id="manager-channel"
              aria-label="Select manager channel"
              autoFocus={isEditing}
              className="w-full"
            >
              <span className="truncate text-left">{selectLabel}</span>
            </SelectTrigger>
            <SelectContent align="start">
              {hasValue ? (
                <>
                  <SelectItem value={CLEAR_MANAGER_CHANNEL_SELECT_VALUE}>
                    Clear selection
                  </SelectItem>
                  <SelectSeparator />
                </>
              ) : null}
              {channelsPending ? (
                <SelectItem value="__loading__" disabled>
                  Loading channels...
                </SelectItem>
              ) : channelsError ? (
                <SelectItem value="__error__" disabled>
                  Could not load channels. Try refreshing.
                </SelectItem>
              ) : slackOptions.length > 0 || discordOptions.length > 0 ? (
                [...slackOptions, ...discordOptions].map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {channel.label}
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="__empty__" disabled>
                  No channels found.
                </SelectItem>
              )}
              <SelectSeparator />
              <SelectItem value={CUSTOM_MANAGER_CHANNEL_SELECT_VALUE}>
                Private or manual channel
              </SelectItem>
            </SelectContent>
          </Select>
          {slackConnected || discordConnected ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh channels"
              title="Refresh channels"
              disabled={
                (!slackConnected && !discordConnected) || channelsFetching
              }
              onClick={onRefresh}
            >
              <RefreshCcw className={cn(channelsFetching && 'animate-spin')} />
            </Button>
          ) : null}
        </div>
        {showCustomInput ? (
          <Input
            value={value.slackChannel}
            onChange={(event) => {
              setIsEnteringCustomChannel(true);
              onChange({
                slackChannel: event.target.value,
                discordChannel: '',
              });
            }}
            placeholder="Enter a private channel name or Slack channel ID"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Private channels may not appear in the list. Use the manual option to
        paste a private channel name or raw Slack channel ID.
      </p>
      {showWarning ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0" />
          Make sure {slackAppMention} is added to that channel.
        </span>
      ) : null}
      {fieldError ? (
        <p className="text-xs text-destructive">{fieldError}</p>
      ) : null}
      {showMigrationNote ? (
        <Alert variant="light">
          <AlertDescription>
            Some older automations still point at different Slack channels. Pick
            the shared Manager Channel here to migrate future manager-facing
            posts onto one destination.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-2 pt-2">
        {isDirty || isSaving ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onReset();
                if (configured) {
                  setIsEditing(false);
                  setIsEnteringCustomChannel(false);
                }
              }}
              disabled={isSaving}
            >
              Reset
            </Button>
            <Button size="sm" onClick={onSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Spinner />
                  Saving...
                  <Check />
                </>
              ) : (
                <>
                  Save <Check />
                </>
              )}
            </Button>
          </div>
        ) : null}
        {configured && isEditing && !isDirty ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(false)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function getSavedManagerChannelLabel({
  savedSlackChannel,
  savedSlackChannelId,
  savedDiscordChannelId,
  slackChannels,
  discordChannels,
}: {
  savedSlackChannel: string;
  savedSlackChannelId: string | null;
  savedDiscordChannelId: string | null;
  slackChannels: SlackChannel[];
  discordChannels: DiscordChannel[];
}) {
  if (savedDiscordChannelId) {
    const channel = discordChannels.find(
      (option) => option.id === savedDiscordChannelId,
    );
    return channel
      ? `${channel.label} (Discord)`
      : `#${savedDiscordChannelId} (Discord)`;
  }

  const channel = slackChannels.find(
    (option) => option.id === savedSlackChannelId,
  );
  if (channel) {
    return `#${channel.name}`;
  }

  return formatSlackChannelValue(savedSlackChannel) || '#channel';
}
