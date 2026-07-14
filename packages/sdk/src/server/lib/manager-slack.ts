import {
  AUTO_RESPOND_CHANNELS_SETTINGS_HASH,
  CODE_QUALITY_AUDITOR_SETTINGS_HASH,
  DEPENDABOT_TRIAGE_SETTINGS_HASH,
  getBackgroundAutomationSettingsDescriptor,
  MANAGER_CHANNEL_SETTINGS_HASH,
  MANAGER_STATS_SETTINGS_HASH,
  SECURITY_AUDITOR_SETTINGS_HASH,
  SENTRY_TRIAGE_SETTINGS_HASH,
  SUGGEST_IDEAS_SETTINGS_HASH,
  SUMMARIZE_MERGED_PRS_SETTINGS_HASH,
} from '@roomote/types';
import { db, eq, users } from '@roomote/db/server';
import { isShowDebugUIEnabledFromMetadata } from '@roomote/feature-flags';
import { convertSlackLinksToMarkdown } from '@roomote/slack';

const DEFAULT_LOCAL_R_APP_URL = 'http://localhost:13000';

export {
  AUTO_RESPOND_CHANNELS_SETTINGS_HASH,
  CODE_QUALITY_AUDITOR_SETTINGS_HASH,
  DEPENDABOT_TRIAGE_SETTINGS_HASH,
  MANAGER_CHANNEL_SETTINGS_HASH,
  MANAGER_STATS_SETTINGS_HASH,
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

export function buildManagerSlackSettingsUrl(
  hash = MANAGER_CHANNEL_SETTINGS_HASH,
) {
  return buildAutomationsSettingsUrl(hash).toString();
}

export function buildManagerSlackFooterText(
  hash = MANAGER_CHANNEL_SETTINGS_HASH,
) {
  return `Manage manager posts: [Settings](${buildManagerSlackSettingsUrl(hash)}).`;
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
    return `Configure this in [automation settings](${buildManagerSlackSettingsUrl(hash)}).`;
  }

  return `Configure the ${settingsDescriptor.label} automation in [automation settings](${buildManagerSlackSettingsUrl(hash)}).`;
}

export function buildAutomationSettingsContextBlock(hash: string) {
  return {
    type: 'markdown',
    text: buildAutomationSettingsContextText(hash),
  };
}

export function buildAutomationSettingsMessage(
  text: string,
  hash: string,
): SlackAutomationSettingsMessage {
  const trimmedText = text.trim();

  return {
    text: trimmedText,
    blocks: [
      {
        type: 'markdown',
        text: trimmedText,
      },
      buildAutomationSettingsContextBlock(hash),
    ],
  };
}

/**
 * Degrades Slack-oriented automation copy to portable markdown for non-Slack
 * communication providers. Converts residual mrkdwn links/bold when present;
 * standard markdown links and bold are left as-is.
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
  try {
    const [user] = await db
      .select({
        metadata: users.metadata,
      })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);

    return isShowDebugUIEnabledFromMetadata(user?.metadata);
  } catch (error) {
    params.warn(
      `${params.logPrefix} Failed to load show-debug-ui preference for user ${params.userId}; skipping historical thread debug snippet: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}
