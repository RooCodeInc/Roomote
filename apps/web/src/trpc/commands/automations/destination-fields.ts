import {
  AUTOMATION_DESTINATION_DESCRIPTORS,
  type AutomationDestinationDescriptorItem,
  type AutomationDestinationDiscordField,
  type AutomationDestinationSlackField,
} from '@roomote/types';

import { normalizeOptionalText } from './channel-auto-start';
import type { UpdateBackgroundAgentSettingsInput } from './types';

type SettingsChannelRecord = Partial<
  Record<
    | AutomationDestinationDescriptorItem['slackSettingsKey']
    | AutomationDestinationDescriptorItem['discordSettingsKey'],
    string | null | undefined
  >
>;

type SubmittedDestinationChannels = {
  slackChannel: string | null;
  discordChannel: string | null;
  /** Whether Discord should be resolved (vs keep-persisted for optional fields). */
  resolveDiscord: boolean;
};

/**
 * One-of Slack-or-Discord submit semantics for the automation being saved.
 * Discord wins when both somehow arrive; optional Discord inputs only resolve
 * when the field is present or Slack was selected.
 */
export function getSubmittedDestinationChannels(
  descriptor: AutomationDestinationDescriptorItem,
  input: UpdateBackgroundAgentSettingsInput,
): SubmittedDestinationChannels {
  const shouldUpdate = input.savingAutomation === descriptor.automationId;
  if (!shouldUpdate) {
    return {
      slackChannel: null,
      discordChannel: null,
      resolveDiscord: false,
    };
  }

  const discordInput =
    input[descriptor.discordField as AutomationDestinationDiscordField];
  const slackInput =
    input[descriptor.slackField as AutomationDestinationSlackField];
  const slackSelected = normalizeOptionalText(slackInput) !== null;
  const resolveDiscord = descriptor.optionalDiscordInput
    ? discordInput !== undefined || slackSelected
    : true;
  const discordChannel = resolveDiscord
    ? normalizeOptionalText(discordInput)
    : null;
  const slackChannel = !discordChannel
    ? normalizeOptionalText(slackInput)
    : null;

  return {
    slackChannel,
    discordChannel,
    resolveDiscord,
  };
}

export function getPersistedSlackChannelForDestination(
  descriptor: AutomationDestinationDescriptorItem,
  existingSettings: SettingsChannelRecord | null | undefined,
): string | null {
  const discordChannelId =
    existingSettings?.[descriptor.discordSettingsKey] ?? null;
  if (descriptor.slackSettingsIncludesManagerFallback && discordChannelId) {
    return null;
  }

  return existingSettings?.[descriptor.slackSettingsKey] ?? null;
}

export function getPersistedDiscordChannelForDestination(
  descriptor: AutomationDestinationDescriptorItem,
  existingSettings: SettingsChannelRecord | null | undefined,
): string | null {
  return existingSettings?.[descriptor.discordSettingsKey] ?? null;
}

export function listAutomationDestinationDescriptors() {
  return AUTOMATION_DESTINATION_DESCRIPTORS;
}
