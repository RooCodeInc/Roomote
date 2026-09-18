import {
  AUTOMATION_DESTINATION_DESCRIPTORS,
  type AutomationDestinationDescriptorItem,
  type AutomationDestinationDiscordField,
  type AutomationDestinationEmailField,
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
  emailIdentityId: string | null;
  /** Whether Email should be replaced instead of preserved for older clients. */
  resolveEmail: boolean;
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
      emailIdentityId: null,
      resolveEmail: false,
      resolveDiscord: false,
    };
  }

  const discordInput =
    input[descriptor.discordField as AutomationDestinationDiscordField];
  const slackInput =
    input[descriptor.slackField as AutomationDestinationSlackField];
  const emailInput =
    input[descriptor.emailField as AutomationDestinationEmailField];
  const emailIdentityId = normalizeOptionalText(emailInput);
  const slackSelected = normalizeOptionalText(slackInput) !== null;
  const discordSelected = normalizeOptionalText(discordInput) !== null;
  const resolveEmail =
    emailInput !== undefined || slackSelected || discordSelected;
  const resolveDiscord = descriptor.optionalDiscordInput
    ? discordInput !== undefined || slackSelected
    : true;
  const discordChannel =
    !emailIdentityId && resolveDiscord
      ? normalizeOptionalText(discordInput)
      : null;
  const slackChannel =
    !emailIdentityId && !discordChannel
      ? normalizeOptionalText(slackInput)
      : null;

  return {
    slackChannel,
    discordChannel,
    emailIdentityId,
    resolveEmail,
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
