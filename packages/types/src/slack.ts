export type SlackBlock =
  | {
      type: 'section' | 'context' | 'actions';
      block_id?: string;
      expand?: boolean;
      text?: { type: string; text: string };
      accessory?: Record<string, unknown>;
      elements?: Record<string, unknown>[];
    }
  | {
      type: 'header';
      block_id?: string;
      text: { type: 'plain_text'; text: string; emoji?: boolean };
    }
  | {
      type: 'markdown';
      text: string;
    }
  | {
      type: 'divider';
    }
  | {
      type: 'image';
      block_id?: string;
      image_url: string;
      alt_text: string;
    }
  | {
      type: 'table';
      block_id?: string;
      rows: Array<Array<Record<string, unknown>>>;
      column_settings?: Array<Record<string, unknown>>;
    }
  | {
      type: 'container';
      block_id?: string;
      title: { type: 'plain_text'; text: string; emoji?: boolean };
      subtitle?: { type: string; text: string };
      icon?: Record<string, unknown>;
      has_header_divider?: boolean;
      width?: 'narrow' | 'standard' | 'wide' | 'full';
      child_blocks: SlackBlock[];
    }
  | {
      /** Native agent task card, fully replaceable via chat.update (unlike
       * streamed task_update chunks, whose body fields only append). */
      type: 'task_card';
      block_id?: string;
      task_id: string;
      title: string;
      status?: 'pending' | 'in_progress' | 'complete' | 'error';
      details?: SlackRichTextValue;
      output?: SlackRichTextValue;
      sources?: Array<{ type: 'url'; url: string; text: string }>;
    };

export interface SlackRichTextValue {
  type: 'rich_text';
  elements: Array<{
    type: 'rich_text_section';
    elements: Array<Record<string, unknown>>;
  }>;
}

/** Wrap plain text as the single-section rich_text value task_card fields
 * expect; splits on newlines so each line renders as its own section. */
export function buildSlackRichTextValue(text: string): SlackRichTextValue {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);

  return {
    type: 'rich_text',
    elements: (lines.length > 0 ? lines : ['']).map((line) => ({
      type: 'rich_text_section',
      elements: [{ type: 'text', text: line }],
    })),
  };
}

export const DEFAULT_SLACK_ACK_EMOJI = 'eyes';
export const DEFAULT_SLACK_COMPLETION_EMOJI = 'white_check_mark';
/** Origin-message reaction when a Slack task is cancelled via the Cancel button. */
export const DEFAULT_SLACK_CANCEL_EMOJI = 'x';

export function buildSlackThreadPermalink(params: {
  slackWorkspaceDomain?: string | null;
  slackTeamId?: string | null;
  slackChannelId?: string | null;
  threadTs?: string | null;
}): string | null {
  const slackChannelId = params.slackChannelId?.trim();
  const threadTs = params.threadTs?.trim();

  if (!slackChannelId || !threadTs) {
    return null;
  }

  const slackWorkspaceDomain = params.slackWorkspaceDomain?.trim();
  const slackTeamId = params.slackTeamId?.trim();

  if (!slackWorkspaceDomain && slackTeamId) {
    return `https://slack.com/app_redirect?channel=${encodeURIComponent(slackChannelId)}&team=${encodeURIComponent(slackTeamId)}`;
  }

  const origin = slackWorkspaceDomain
    ? `https://${encodeURIComponent(slackWorkspaceDomain)}.slack.com`
    : 'https://app.slack.com';
  const permalinkTs = threadTs.replaceAll('.', '');

  return `${origin}/archives/${encodeURIComponent(slackChannelId)}/p${permalinkTs}?thread_ts=${encodeURIComponent(threadTs)}&cid=${encodeURIComponent(slackChannelId)}`;
}

const SLACK_CHANNEL_ID = /^[A-Z0-9]+$/i;
const SLACK_PERMALINK_TIMESTAMP = /^\d{7,}$/;
const SLACK_TIMESTAMP = /^\d+(?:\.\d+)?$/;

function parseSlackLinkSegments(raw: string): string[] | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'slack.com' && !host.endsWith('.slack.com')) {
    return null;
  }

  try {
    return url.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * Parse the two Slack message-link shapes Roomote receives from routing:
 * workspace/app archive permalinks and app client thread links.
 */
export function parseSlackMessagePermalink(raw: string): {
  teamId: string | null;
  channelId: string;
  messageId: string;
} | null {
  const segments = parseSlackLinkSegments(raw);
  if (!segments) return null;

  if (segments[0] === 'archives' && segments.length === 3) {
    const channelId = segments[1] ?? '';
    const permalinkTs = (segments[2] ?? '').replace(/^p/i, '');
    if (
      !SLACK_CHANNEL_ID.test(channelId) ||
      !SLACK_PERMALINK_TIMESTAMP.test(permalinkTs)
    ) {
      return null;
    }

    return {
      teamId: null,
      channelId,
      messageId: `${permalinkTs.slice(0, -6)}.${permalinkTs.slice(-6)}`,
    };
  }

  if (
    segments[0] === 'client' &&
    segments[3] === 'thread' &&
    segments.length === 5
  ) {
    const teamId = segments[1] ?? '';
    const channelId = segments[2] ?? '';
    const threadTarget = segments[4] ?? '';
    const messageId = threadTarget.startsWith(`${channelId}-`)
      ? threadTarget.slice(channelId.length + 1)
      : '';
    if (
      !SLACK_CHANNEL_ID.test(teamId) ||
      !SLACK_CHANNEL_ID.test(channelId) ||
      !SLACK_TIMESTAMP.test(messageId)
    ) {
      return null;
    }

    return { teamId, channelId, messageId };
  }

  return null;
}

/** Parse Slack archive and app-client channel links without requiring a message. */
export function parseSlackChannelPermalink(raw: string): {
  teamId: string | null;
  channelId: string;
} | null {
  const segments = parseSlackLinkSegments(raw);
  if (!segments) return null;

  if (segments[0] === 'archives' && segments.length === 2) {
    const channelId = segments[1] ?? '';
    return SLACK_CHANNEL_ID.test(channelId)
      ? { teamId: null, channelId }
      : null;
  }

  if (segments[0] === 'client' && segments.length === 3) {
    const teamId = segments[1] ?? '';
    const channelId = segments[2] ?? '';
    return SLACK_CHANNEL_ID.test(teamId) && SLACK_CHANNEL_ID.test(channelId)
      ? { teamId, channelId }
      : null;
  }

  return null;
}
