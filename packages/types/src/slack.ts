export type SlackTableCell =
  | { type: 'raw_text'; text: string }
  | { type: 'rich_text'; elements: Array<Record<string, unknown>> };

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
      rows: SlackTableCell[][];
      column_settings?: Array<{
        align?: 'left' | 'center' | 'right';
        is_wrapped?: boolean;
      }>;
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
    };

export const DEFAULT_SLACK_ACK_EMOJI = 'eyes';
export const DEFAULT_SLACK_COMPLETION_EMOJI = 'white_check_mark';
/** Origin-message reaction when a Slack task is cancelled via the Cancel button. */
export const DEFAULT_SLACK_CANCEL_EMOJI = 'x';

export function buildSlackThreadPermalink(params: {
  slackWorkspaceDomain?: string | null;
  slackTeamId?: string | null;
  slackChannelId?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
}): string | null {
  const slackChannelId = params.slackChannelId?.trim();
  const threadTs = params.threadTs?.trim();
  const messageTs = params.messageTs?.trim();

  if (!slackChannelId || !threadTs) {
    return null;
  }

  const slackWorkspaceDomain = params.slackWorkspaceDomain?.trim();
  const slackTeamId = params.slackTeamId?.trim();

  if (!slackWorkspaceDomain && slackTeamId && !messageTs) {
    return `https://slack.com/app_redirect?channel=${encodeURIComponent(slackChannelId)}&team=${encodeURIComponent(slackTeamId)}`;
  }

  const origin = slackWorkspaceDomain
    ? `https://${encodeURIComponent(slackWorkspaceDomain)}.slack.com`
    : 'https://app.slack.com';
  const permalinkTs = (messageTs || threadTs).replaceAll('.', '');

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

/**
 * Slack-native inline references that can appear in raw message text.
 * Roomote persists inbound Slack text verbatim so the model sees exactly
 * what the sender typed; the web transcript uses these tokens to render
 * readable, linked equivalents without rewriting the stored text.
 */
export type SlackMessageToken =
  | { type: 'text'; text: string }
  | { type: 'user'; userId: string; label: string | null }
  | { type: 'channel'; channelId: string; label: string | null }
  | { type: 'usergroup'; usergroupId: string; label: string | null }
  | { type: 'broadcast'; name: string };

/** Upper bound on Slack user IDs resolved in one `slack.resolveUsers` call. */
export const SLACK_RESOLVE_USERS_MAX_IDS = 50;

// Each pattern is anchored and applied only to the bounded text between one
// `<` and the next `>`, so parsing stays linear in the message length even
// for sender-controlled text full of unterminated `<@U0|` fragments.
const SLACK_USER_REFERENCE_PATTERN = /^@([UW][A-Z0-9]+)(?:\|([^|]*))?$/;
const SLACK_CHANNEL_REFERENCE_PATTERN = /^#([CDG][A-Z0-9]+)(?:\|([^|]*))?$/;
const SLACK_USERGROUP_REFERENCE_PATTERN =
  /^!subteam\^([A-Z0-9]+)(?:\|([^|]*))?$/;
const SLACK_BROADCAST_REFERENCE_PATTERN = /^!(here|channel|everyone)(?:\|.*)?$/;

function normalizeSlackTokenLabel(label: string | undefined): string | null {
  const trimmed = label?.trim().replace(/^@/, '') ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function parseSlackReference(inner: string): SlackMessageToken | null {
  const user = SLACK_USER_REFERENCE_PATTERN.exec(inner);
  if (user?.[1]) {
    return {
      type: 'user',
      userId: user[1],
      label: normalizeSlackTokenLabel(user[2]),
    };
  }

  const channel = SLACK_CHANNEL_REFERENCE_PATTERN.exec(inner);
  if (channel?.[1]) {
    return {
      type: 'channel',
      channelId: channel[1],
      label: normalizeSlackTokenLabel(channel[2]),
    };
  }

  const usergroup = SLACK_USERGROUP_REFERENCE_PATTERN.exec(inner);
  if (usergroup?.[1]) {
    return {
      type: 'usergroup',
      usergroupId: usergroup[1],
      label: normalizeSlackTokenLabel(usergroup[2]),
    };
  }

  const broadcast = SLACK_BROADCAST_REFERENCE_PATTERN.exec(inner);
  if (broadcast?.[1]) {
    return { type: 'broadcast', name: broadcast[1] };
  }

  return null;
}

/**
 * Splits raw Slack message text into plain-text runs and Slack references
 * (`<@U123>`, `<@U123|name>`, `<#C123|general>`, `<!subteam^S123|@team>`,
 * `<!here>`). Text without references comes back as a single text token.
 *
 * Single forward scan: a `<` opens a candidate, the candidate ends at the
 * next `>`, and another `<` before that restarts the candidate there, so no
 * character is examined more than a constant number of times.
 */
export function parseSlackMessageTokens(text: string): SlackMessageToken[] {
  const tokens: SlackMessageToken[] = [];
  let textStart = 0;
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open === -1) {
      break;
    }

    let cursor = open + 1;
    while (
      cursor < text.length &&
      text[cursor] !== '>' &&
      text[cursor] !== '<'
    ) {
      cursor += 1;
    }

    if (cursor >= text.length) {
      break;
    }

    if (text[cursor] === '<') {
      index = cursor;
      continue;
    }

    const token = parseSlackReference(text.slice(open + 1, cursor));
    if (token) {
      if (open > textStart) {
        tokens.push({ type: 'text', text: text.slice(textStart, open) });
      }
      tokens.push(token);
      textStart = cursor + 1;
    }
    index = cursor + 1;
  }

  if (textStart < text.length) {
    tokens.push({ type: 'text', text: text.slice(textStart) });
  }

  return tokens;
}

/** Unique Slack user IDs referenced by `<@U…>` tokens, in first-seen order. */
export function extractSlackUserMentionIds(text: string): string[] {
  const userIds = new Set<string>();
  for (const token of parseSlackMessageTokens(text)) {
    if (token.type === 'user') {
      userIds.add(token.userId);
    }
  }
  return [...userIds];
}

/**
 * Link to a Slack member profile. Prefers the workspace web URL when the
 * workspace domain is known and falls back to the `slack://` deep link that
 * the desktop app handles when only the team ID is available.
 */
export function buildSlackUserProfileUrl(params: {
  slackUserId: string;
  slackTeamId?: string | null;
  slackWorkspaceDomain?: string | null;
}): string | null {
  const slackUserId = params.slackUserId.trim();
  if (!slackUserId) {
    return null;
  }

  const slackWorkspaceDomain = params.slackWorkspaceDomain?.trim();
  if (slackWorkspaceDomain) {
    return `https://${encodeURIComponent(slackWorkspaceDomain)}.slack.com/team/${encodeURIComponent(slackUserId)}`;
  }

  const slackTeamId = params.slackTeamId?.trim();
  if (slackTeamId) {
    return `slack://user?team=${encodeURIComponent(slackTeamId)}&id=${encodeURIComponent(slackUserId)}`;
  }

  return null;
}
