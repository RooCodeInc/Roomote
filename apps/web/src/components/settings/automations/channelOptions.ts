export const DISCORD_DESTINATION_OPTION_PREFIX = 'discord:';

export type SlackChannelOption = {
  id: string;
  name: string;
  label: string;
  isPrivate?: boolean;
  isMember?: boolean | null;
};

export function formatSlackChannelValue(
  value: string | null | undefined,
): string {
  const trimmedValue = value?.trim() ?? '';

  if (!trimmedValue) {
    return '';
  }

  if (trimmedValue.startsWith('#') || /^[CGD][A-Z0-9]+$/i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `#${trimmedValue}`;
}

export function matchesSlackChannelOption(
  value: string | null | undefined,
  option: SlackChannelOption,
): boolean {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  return (
    normalizedValue === option.id.toLowerCase() ||
    normalizedValue === option.name.toLowerCase() ||
    normalizedValue === option.label.toLowerCase()
  );
}

export function buildManagerSlackChannelOptions(params: {
  channels: Array<{ id: string; name: string }>;
  selectedValue: string | null | undefined;
}): SlackChannelOption[] {
  const options = params.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    label: `#${channel.name}`,
  }));

  const selectedValue = params.selectedValue?.trim();
  if (
    !selectedValue ||
    options.some((option) => matchesSlackChannelOption(selectedValue, option))
  ) {
    return options;
  }

  return [
    {
      id: selectedValue,
      name: selectedValue.startsWith('#')
        ? selectedValue.slice(1)
        : selectedValue,
      label: formatSlackChannelValue(selectedValue),
    },
    ...options,
  ];
}

export function buildAutomationDiscordDestinationOptions(params: {
  channels: Array<{ id: string; name: string; label: string }>;
  selectedChannelId: string | null | undefined;
  includeProviderSuffix: boolean;
}): SlackChannelOption[] {
  const suffix = params.includeProviderSuffix ? ' (Discord)' : '';
  const options = params.channels.map((channel) => ({
    id: `${DISCORD_DESTINATION_OPTION_PREFIX}${channel.id}`,
    name: channel.name,
    label: `${channel.label}${suffix}`,
  }));

  const selectedChannelId = params.selectedChannelId?.trim();
  const selectedOptionId = selectedChannelId
    ? `${DISCORD_DESTINATION_OPTION_PREFIX}${selectedChannelId}`
    : null;

  if (
    !selectedOptionId ||
    options.some((option) => option.id === selectedOptionId)
  ) {
    return options;
  }

  return [
    {
      id: selectedOptionId,
      name: selectedChannelId!,
      label: `#${selectedChannelId}${suffix}`,
    },
    ...options,
  ];
}

export function isManagerChannelSelectionDisabled(params: {
  slackConnected: boolean;
  isFetching: boolean;
  hasValue: boolean;
  isConfigured: boolean;
}): boolean {
  return (
    params.isFetching ||
    (!params.slackConnected && !params.hasValue && !params.isConfigured)
  );
}

export function shouldShowManagerSlackChannelWarning({
  formValue,
  savedChannelId,
  warningChannelId,
  isDirty,
}: {
  formValue: string | null | undefined;
  savedChannelId: string | null | undefined;
  warningChannelId: string | null | undefined;
  isDirty: boolean;
}): boolean {
  const trimmedFormValue = formValue?.trim();

  if (!trimmedFormValue || !warningChannelId) {
    return false;
  }

  if (warningChannelId.toLowerCase() === trimmedFormValue.toLowerCase()) {
    return true;
  }

  return !isDirty && savedChannelId === warningChannelId;
}
