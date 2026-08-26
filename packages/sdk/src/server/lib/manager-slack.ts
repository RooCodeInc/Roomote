import {
  AUTO_RESPOND_CHANNELS_SETTINGS_HASH,
  CODE_QUALITY_AUDITOR_SETTINGS_HASH,
  CODEQL_TRIAGE_SETTINGS_HASH,
  CI_FAILURE_TRIAGE_SETTINGS_HASH,
  DEPENDABOT_TRIAGE_SETTINGS_HASH,
  getBackgroundAutomationSettingsDescriptor,
  getTriggerableBackgroundAutomationDescriptorByKey,
  MANAGER_CHANNEL_SETTINGS_HASH,
  MANAGER_STATS_SETTINGS_HASH,
  PLATFORM_ISSUE_ALERTS_SETTINGS_HASH,
  SECURITY_AUDITOR_SETTINGS_HASH,
  SENTRY_TRIAGE_SETTINGS_HASH,
  SUGGEST_IDEAS_SETTINGS_HASH,
  SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
  type SlackBlock,
} from '@roomote/types';
import {
  buildAutomationResultBlocks,
  convertSlackLinksToMarkdown,
} from '@roomote/slack';

const DEFAULT_LOCAL_R_APP_URL = 'http://localhost:13000';

export {
  AUTO_RESPOND_CHANNELS_SETTINGS_HASH,
  CODE_QUALITY_AUDITOR_SETTINGS_HASH,
  CODEQL_TRIAGE_SETTINGS_HASH,
  CI_FAILURE_TRIAGE_SETTINGS_HASH,
  DEPENDABOT_TRIAGE_SETTINGS_HASH,
  MANAGER_CHANNEL_SETTINGS_HASH,
  MANAGER_STATS_SETTINGS_HASH,
  PLATFORM_ISSUE_ALERTS_SETTINGS_HASH,
  SECURITY_AUDITOR_SETTINGS_HASH,
  SENTRY_TRIAGE_SETTINGS_HASH,
  SUGGEST_IDEAS_SETTINGS_HASH,
  SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
};

export type SlackAutomationSettingsMessage = {
  text: string;
  blocks: unknown[];
};

function buildAutomationsSettingsUrl(hash?: string) {
  const url = new URL(
    '/automations',
    process.env.R_APP_URL || DEFAULT_LOCAL_R_APP_URL,
  );

  if (hash) {
    url.hash = hash;
  }

  return url;
}

export function buildAutomationIconUrl(icon: string) {
  return new URL(
    `/automation-icons/${icon}.png`,
    process.env.R_APP_URL || DEFAULT_LOCAL_R_APP_URL,
  ).toString();
}

export function buildCustomAutomationSettingsUrl(automationId: string) {
  return buildAutomationsSettingsUrl(
    `custom-automation-${automationId}`,
  ).toString();
}

export function buildCustomAutomationSlackMessage(params: {
  automationId: string;
  automationName: string;
  text: string;
  contentBlocks?: SlackBlock[];
}): SlackAutomationSettingsMessage {
  return {
    text: params.text,
    blocks: buildAutomationResultBlocks({
      title: params.automationName,
      iconUrl: buildAutomationIconUrl('zap'),
      configureUrl: buildCustomAutomationSettingsUrl(params.automationId),
      contentBlocks: params.contentBlocks ?? [
        { type: 'markdown', text: params.text },
      ],
    }),
  };
}

export function buildManagerSlackSettingsUrl(
  hash = MANAGER_CHANNEL_SETTINGS_HASH,
) {
  return buildAutomationsSettingsUrl(hash).toString();
}

export function buildModelsSettingsUrl() {
  return new URL(
    '/settings/models',
    process.env.R_APP_URL || DEFAULT_LOCAL_R_APP_URL,
  ).toString();
}

export function buildManagerSlackFooterText(
  hash = MANAGER_CHANNEL_SETTINGS_HASH,
) {
  return `Manage manager posts: <${buildManagerSlackSettingsUrl(hash)}|Settings>.`;
}

export function appendManagerSlackFooter(
  text: string,
  hash = MANAGER_CHANNEL_SETTINGS_HASH,
) {
  return [text.trim(), buildManagerSlackFooterText(hash)]
    .filter(Boolean)
    .join('\n\n');
}

export function buildAutomationSettingsContextText(hash: string) {
  const settingsDescriptor = getBackgroundAutomationSettingsDescriptor(hash);

  if (!settingsDescriptor) {
    return `Configure this in <${buildManagerSlackSettingsUrl(hash)}|automation settings>.`;
  }

  return `Configure the ${settingsDescriptor.label} automation in <${buildManagerSlackSettingsUrl(hash)}|automation settings>.`;
}

export function buildAutomationSettingsContextBlock(hash: string) {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: buildAutomationSettingsContextText(hash),
      },
    ],
  };
}

export function buildAutomationSettingsMessage(
  text: string,
  hash: string,
  options?: { taskUrl?: string | null; slackIcon?: string },
): SlackAutomationSettingsMessage {
  const trimmedText = text.trim();
  const settingsDescriptor = getBackgroundAutomationSettingsDescriptor(hash);
  const automationDescriptor = settingsDescriptor?.automationKey
    ? getTriggerableBackgroundAutomationDescriptorByKey(
        settingsDescriptor.automationKey,
      )
    : null;
  const title = settingsDescriptor?.label ?? 'Automation';

  return {
    text: trimmedText,
    blocks: buildAutomationResultBlocks({
      title,
      iconUrl: buildAutomationIconUrl(
        options?.slackIcon ?? automationDescriptor?.slackIcon ?? 'zap',
      ),
      configureUrl: buildManagerSlackSettingsUrl(hash),
      taskUrl: options?.taskUrl,
      contentBlocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: trimmedText },
        },
      ],
    }),
  };
}

/**
 * Degrades Slack mrkdwn automation text to standard markdown for non-Slack
 * communication providers: `<url|label>` links become `[label](url)` and
 * single-asterisk bold becomes double-asterisk bold. Other mrkdwn forms
 * (italic `_text_`, bullets, plain URLs) already read correctly as markdown.
 */
export function degradeSlackMrkdwnToMarkdown(text: string): string {
  return convertSlackLinksToMarkdown(text).replace(
    /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g,
    '**$1**',
  );
}

export function buildAutomationRootSummaryText(params: {
  summaryText: string;
  actionFooterText?: string | null;
}) {
  return [params.summaryText.trim(), params.actionFooterText?.trim()]
    .filter(Boolean)
    .join('\n\n');
}

export function buildAutomationRootSummaryMessage(params: {
  summaryText: string;
  automationSettingsHash: string;
  actionFooterText?: string | null;
}): SlackAutomationSettingsMessage {
  return buildAutomationSettingsMessage(
    buildAutomationRootSummaryText({
      summaryText: params.summaryText,
      actionFooterText: params.actionFooterText,
    }),
    params.automationSettingsHash,
  );
}

export async function shouldPostHistoricalThreadFeedbackDebugSnippet(params: {
  userId: string;
  logPrefix: string;
  warn: (message: string) => void;
}) {
  void params;
  return false;
}
