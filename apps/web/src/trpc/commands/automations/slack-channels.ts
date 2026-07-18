import { db, desc, eq, slackInstallations } from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from './feature-gates';
import type {
  SlackChannelAccessWarnings,
  SlackChannelDisplayNames,
  SlackChannelFieldErrorKey,
} from './types';

export const REQUIRED_BACKGROUND_AGENT_SCOPES = [
  'channels:read',
  'groups:read',
  'reactions:read',
  'team:read',
] as const;

const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;
const SLACK_CHANNEL_NAME_REGEX = /^[a-z0-9._-]+$/i;

export function normalizeSlackChannelIdInput(
  input: string | null | undefined,
): string | null {
  const trimmed = input?.trim();

  if (!trimmed || !SLACK_CHANNEL_ID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed.toUpperCase();
}

export function extractSlackBotScopes(scopes: unknown): string[] {
  if (!scopes) {
    return [];
  }

  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === 'string');
  }

  if (typeof scopes === 'object') {
    const botScopes = (scopes as { bot?: unknown }).bot;

    if (Array.isArray(botScopes)) {
      return botScopes.filter(
        (scope): scope is string => typeof scope === 'string',
      );
    }
  }

  return [];
}

export async function findActiveSlackInstallationForOrg() {
  return db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    orderBy: [desc(slackInstallations.updatedAt)],
  });
}

export async function resolveChannelId({
  field,
  input,
  notifier,
}: {
  field: SlackChannelFieldErrorKey;
  input: string | null;
  notifier: SlackNotifier | null;
}): Promise<{
  channelId: string | null;
  channelName?: string | null;
  error?: {
    field: SlackChannelFieldErrorKey;
    message: string;
  };
}> {
  if (!input) {
    return { channelId: null };
  }

  const submittedChannelId = normalizeSlackChannelIdInput(input);
  if (submittedChannelId) {
    return { channelId: submittedChannelId, channelName: null };
  }

  const channelNameInput = input.startsWith('#') ? input.slice(1) : input;
  const normalizedChannelName = channelNameInput.trim().toLowerCase();

  if (
    !normalizedChannelName ||
    !SLACK_CHANNEL_NAME_REGEX.test(normalizedChannelName)
  ) {
    return {
      channelId: null,
      error: {
        field,
        message:
          'Enter a channel ID (for example C123ABC456) or a channel name.',
      },
    };
  }

  if (!notifier) {
    return {
      channelId: null,
      error: {
        field,
        message: 'Connect Slack to first, please.',
      },
    };
  }

  const normalizedInput = `#${normalizedChannelName}`;
  const resolved = await notifier.resolveChannelId(normalizedInput);

  if (!resolved) {
    return {
      channelId: null,
      error: {
        field,
        message: `Could not resolve Slack channel ${normalizedInput}.`,
      },
    };
  }

  return { channelId: resolved, channelName: normalizedInput };
}

export async function getSlackChannelAccessWarnings({
  notifier,
  channelAutoStartSlackChannelIds,
  managerStatsSlackChannelId,
  suggesterSlackChannelId,
  announcerSlackChannelId,
  platformIssueSlackChannelId,
  sentryTriageSlackChannelId,
  dependabotTriageSlackChannelId,
  codeqlTriageSlackChannelId,
  issueFixerSlackChannelId,
  securityAuditorSlackChannelId,
  codeQualityAuditorSlackChannelId,
  ciFailureTriageSlackChannelId,
}: {
  notifier: SlackNotifier | null;
  channelAutoStartSlackChannelIds: string[];
  managerStatsSlackChannelId: string | null;
  suggesterSlackChannelId: string | null;
  announcerSlackChannelId: string | null;
  platformIssueSlackChannelId: string | null;
  sentryTriageSlackChannelId: string | null;
  dependabotTriageSlackChannelId: string | null;
  codeqlTriageSlackChannelId: string | null;
  issueFixerSlackChannelId: string | null;
  securityAuditorSlackChannelId: string | null;
  codeQualityAuditorSlackChannelId: string | null;
  ciFailureTriageSlackChannelId: string | null;
}): Promise<SlackChannelAccessWarnings> {
  if (!notifier) {
    return {
      channelAutoStartSlackChannels: [],
      managerSlackChannel: null,
      managerStatsSlackChannel: null,
      suggesterSlackChannel: null,
      announcerSlackChannel: null,
      platformIssueSlackChannel: null,
      sentryTriageSlackChannel: null,
      dependabotTriageSlackChannel: null,
      codeqlTriageSlackChannel: null,
      issueFixerSlackChannel: null,
      securityAuditorSlackChannel: null,
      codeQualityAuditorSlackChannel: null,
      ciFailureTriageSlackChannel: null,
    };
  }

  const channelIds = [
    ...channelAutoStartSlackChannelIds,
    managerStatsSlackChannelId,
    suggesterSlackChannelId,
    announcerSlackChannelId,
    platformIssueSlackChannelId,
    sentryTriageSlackChannelId,
    dependabotTriageSlackChannelId,
    codeqlTriageSlackChannelId,
    issueFixerSlackChannelId,
    securityAuditorSlackChannelId,
    codeQualityAuditorSlackChannelId,
    ciFailureTriageSlackChannelId,
  ].filter((channelId): channelId is string => Boolean(channelId));

  const membershipByChannelId = new Map<string, boolean | null>();

  await Promise.all(
    [...new Set(channelIds)].map(async (channelId) => {
      membershipByChannelId.set(
        channelId,
        await notifier.isAppInChannel(channelId),
      );
    }),
  );

  return {
    channelAutoStartSlackChannels: channelAutoStartSlackChannelIds.filter(
      (channelId) => membershipByChannelId.get(channelId) !== true,
    ),
    managerSlackChannel: null,
    managerStatsSlackChannel:
      managerStatsSlackChannelId &&
      membershipByChannelId.get(managerStatsSlackChannelId) !== true
        ? managerStatsSlackChannelId
        : null,
    suggesterSlackChannel:
      suggesterSlackChannelId &&
      membershipByChannelId.get(suggesterSlackChannelId) !== true
        ? suggesterSlackChannelId
        : null,
    announcerSlackChannel:
      announcerSlackChannelId &&
      membershipByChannelId.get(announcerSlackChannelId) !== true
        ? announcerSlackChannelId
        : null,
    platformIssueSlackChannel:
      platformIssueSlackChannelId &&
      membershipByChannelId.get(platformIssueSlackChannelId) !== true
        ? platformIssueSlackChannelId
        : null,
    sentryTriageSlackChannel:
      sentryTriageSlackChannelId &&
      membershipByChannelId.get(sentryTriageSlackChannelId) !== true
        ? sentryTriageSlackChannelId
        : null,
    dependabotTriageSlackChannel:
      dependabotTriageSlackChannelId &&
      membershipByChannelId.get(dependabotTriageSlackChannelId) !== true
        ? dependabotTriageSlackChannelId
        : null,
    codeqlTriageSlackChannel:
      codeqlTriageSlackChannelId &&
      membershipByChannelId.get(codeqlTriageSlackChannelId) !== true
        ? codeqlTriageSlackChannelId
        : null,
    issueFixerSlackChannel:
      issueFixerSlackChannelId &&
      membershipByChannelId.get(issueFixerSlackChannelId) !== true
        ? issueFixerSlackChannelId
        : null,
    securityAuditorSlackChannel:
      securityAuditorSlackChannelId &&
      membershipByChannelId.get(securityAuditorSlackChannelId) !== true
        ? securityAuditorSlackChannelId
        : null,
    codeQualityAuditorSlackChannel:
      codeQualityAuditorSlackChannelId &&
      membershipByChannelId.get(codeQualityAuditorSlackChannelId) !== true
        ? codeQualityAuditorSlackChannelId
        : null,
    ciFailureTriageSlackChannel:
      ciFailureTriageSlackChannelId &&
      membershipByChannelId.get(ciFailureTriageSlackChannelId) !== true
        ? ciFailureTriageSlackChannelId
        : null,
  };
}

export async function getSlackChannelDisplayNames({
  notifier,
  channelAutoStartSlackChannelIds,
  managerSlackChannelId,
  managerStatsSlackChannelId,
  suggesterSlackChannelId,
  announcerSlackChannelId,
  platformIssueSlackChannelId,
  sentryTriageSlackChannelId,
  dependabotTriageSlackChannelId,
  codeqlTriageSlackChannelId,
  issueFixerSlackChannelId,
  securityAuditorSlackChannelId,
  codeQualityAuditorSlackChannelId,
  ciFailureTriageSlackChannelId,
}: {
  notifier: SlackNotifier | null;
  channelAutoStartSlackChannelIds: string[];
  managerSlackChannelId: string | null;
  managerStatsSlackChannelId: string | null;
  suggesterSlackChannelId: string | null;
  announcerSlackChannelId: string | null;
  platformIssueSlackChannelId: string | null;
  sentryTriageSlackChannelId: string | null;
  dependabotTriageSlackChannelId: string | null;
  codeqlTriageSlackChannelId: string | null;
  issueFixerSlackChannelId: string | null;
  securityAuditorSlackChannelId: string | null;
  codeQualityAuditorSlackChannelId: string | null;
  ciFailureTriageSlackChannelId: string | null;
}): Promise<SlackChannelDisplayNames> {
  if (!notifier) {
    return {
      channelAutoStartSlackChannels: {},
      managerSlackChannel: null,
      managerStatsSlackChannel: null,
      suggesterSlackChannel: null,
      announcerSlackChannel: null,
      platformIssueSlackChannel: null,
      sentryTriageSlackChannel: null,
      dependabotTriageSlackChannel: null,
      codeqlTriageSlackChannel: null,
      issueFixerSlackChannel: null,
      securityAuditorSlackChannel: null,
      codeQualityAuditorSlackChannel: null,
      ciFailureTriageSlackChannel: null,
    };
  }

  const uniqueChannelIds = [...new Set(channelAutoStartSlackChannelIds)];
  const [
    channelAutoStartChannelNames,
    managerSlackChannel,
    managerStatsSlackChannel,
    suggesterSlackChannel,
    announcerSlackChannel,
    platformIssueSlackChannel,
    sentryTriageSlackChannel,
    dependabotTriageSlackChannel,
    codeqlTriageSlackChannel,
    issueFixerSlackChannel,
    securityAuditorSlackChannel,
    codeQualityAuditorSlackChannel,
    ciFailureTriageSlackChannel,
  ] = await Promise.all([
    Promise.all(
      uniqueChannelIds.map(async (channelId) => [
        channelId,
        await notifier.getChannelName(channelId),
      ]),
    ),
    managerSlackChannelId
      ? notifier.getChannelName(managerSlackChannelId)
      : Promise.resolve(null),
    managerStatsSlackChannelId
      ? notifier.getChannelName(managerStatsSlackChannelId)
      : Promise.resolve(null),
    suggesterSlackChannelId
      ? notifier.getChannelName(suggesterSlackChannelId)
      : Promise.resolve(null),
    announcerSlackChannelId
      ? notifier.getChannelName(announcerSlackChannelId)
      : Promise.resolve(null),
    platformIssueSlackChannelId
      ? notifier.getChannelName(platformIssueSlackChannelId)
      : Promise.resolve(null),
    sentryTriageSlackChannelId
      ? notifier.getChannelName(sentryTriageSlackChannelId)
      : Promise.resolve(null),
    dependabotTriageSlackChannelId
      ? notifier.getChannelName(dependabotTriageSlackChannelId)
      : Promise.resolve(null),
    codeqlTriageSlackChannelId
      ? notifier.getChannelName(codeqlTriageSlackChannelId)
      : Promise.resolve(null),
    issueFixerSlackChannelId
      ? notifier.getChannelName(issueFixerSlackChannelId)
      : Promise.resolve(null),
    securityAuditorSlackChannelId
      ? notifier.getChannelName(securityAuditorSlackChannelId)
      : Promise.resolve(null),
    codeQualityAuditorSlackChannelId
      ? notifier.getChannelName(codeQualityAuditorSlackChannelId)
      : Promise.resolve(null),
    ciFailureTriageSlackChannelId
      ? notifier.getChannelName(ciFailureTriageSlackChannelId)
      : Promise.resolve(null),
  ]);

  return {
    channelAutoStartSlackChannels: Object.fromEntries(
      channelAutoStartChannelNames.map(([channelId, channelName]) => [
        channelId,
        channelName ? `#${channelName}` : null,
      ]),
    ),
    managerSlackChannel: managerSlackChannel ? `#${managerSlackChannel}` : null,
    managerStatsSlackChannel: managerStatsSlackChannel
      ? `#${managerStatsSlackChannel}`
      : null,
    suggesterSlackChannel: suggesterSlackChannel
      ? `#${suggesterSlackChannel}`
      : null,
    announcerSlackChannel: announcerSlackChannel
      ? `#${announcerSlackChannel}`
      : null,
    platformIssueSlackChannel: platformIssueSlackChannel
      ? `#${platformIssueSlackChannel}`
      : null,
    sentryTriageSlackChannel: sentryTriageSlackChannel
      ? `#${sentryTriageSlackChannel}`
      : null,
    dependabotTriageSlackChannel: dependabotTriageSlackChannel
      ? `#${dependabotTriageSlackChannel}`
      : null,
    codeqlTriageSlackChannel: codeqlTriageSlackChannel
      ? `#${codeqlTriageSlackChannel}`
      : null,
    issueFixerSlackChannel: issueFixerSlackChannel
      ? `#${issueFixerSlackChannel}`
      : null,
    securityAuditorSlackChannel: securityAuditorSlackChannel
      ? `#${securityAuditorSlackChannel}`
      : null,
    codeQualityAuditorSlackChannel: codeQualityAuditorSlackChannel
      ? `#${codeQualityAuditorSlackChannel}`
      : null,
    ciFailureTriageSlackChannel: ciFailureTriageSlackChannel
      ? `#${ciFailureTriageSlackChannel}`
      : null,
  };
}

export async function listSlackChannelsCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const slackInstallation = await findActiveSlackInstallationForOrg();

  if (!slackInstallation) {
    return { channels: [] };
  }

  const notifier = new SlackNotifier(slackInstallation.botAccessToken);
  const channels = await notifier.listAccessibleChannels();

  return {
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      label: channel.isPrivate
        ? `#${channel.name} (private)`
        : `#${channel.name}`,
      isPrivate: channel.isPrivate,
      isMember: channel.isMember,
    })),
  };
}
