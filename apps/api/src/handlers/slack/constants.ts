import { Env } from '@roomote/env';

const UNFURL_ALLOWED_DOMAIN_SUFFIXES = new Set(
  (Env.SLACK_UNFURL_ALLOWED_DOMAINS ?? new URL(Env.R_APP_URL).hostname)
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0),
);

export const SLACK_TASK_REPLY_SYNC_TOLERANCE_MS = 1_000;
export const START_SLACK_TASK_CALLBACK_ID = 'start_roomote_task';
export const SLACK_WORKFLOW_CHANNEL_INPUT_KEYS = ['channel_id'] as const;
export const SLACK_WORKFLOW_PROMPT_INPUT_KEYS = ['prompt'] as const;
export const SLACK_WORKFLOW_THREAD_INPUT_KEYS = ['message_ts'] as const;
export const SLACK_WORKFLOW_PROMPT_AUTHOR_INPUT_KEYS = [
  'prompt_author_id',
] as const;
export const EVENT_DEDUP_TTL_SECONDS = 3600;
export const SLACK_EVENT_DEDUP_PREFIX = 'slack:event:';
export const SLACK_WORKFLOW_COMPLETION_PREFIX = 'slack:workflow-completion:';
export const SLACK_WORKFLOW_COMPLETION_TTL_SECONDS = 24 * 60 * 60;
export const ROUTING_LOCK_TTL_SECONDS = 60;
export const FAST_AGENT_LOCK_TTL_SECONDS = 600;
export const SLACK_WELCOME_MESSAGE_CHANNEL_LIMIT = 3;
export const SLACK_ROUTING_LOCK_PREFIX = 'slack:routing-lock:';
export const SLACK_FAST_AGENT_LOCK_PREFIX = 'slack:fast-agent-lock:';
export const SLACK_SETUP_SUGGESTION_LOCK_PREFIX =
  'slack:setup-suggestion-reaction:';
export const LEADING_FAST_COMMAND_MENTION_PATTERN = /^\s*<@[^>]+>[\s,:;.-]*/;
const SETUP_ONBOARDING_SUGGESTION_AGENT_TYPE = 'setup_onboarding';
const SUGGESTED_TASKS_AGENT_TYPE = 'suggested_tasks';
export const TASK_SUGGESTION_AGENT_TYPES = [
  SETUP_ONBOARDING_SUGGESTION_AGENT_TYPE,
  SUGGESTED_TASKS_AGENT_TYPE,
] as const;
export const SETUP_ONBOARDING_SUGGESTION_METADATA_EVENT_TYPE =
  'roomote.setup_onboarding_suggestion';
export const THUMBS_UP_REACTIONS = new Set(['+1', 'thumbsup']);

export const isAllowedUnfurlDomain = (domain: string): boolean => {
  for (const suffix of UNFURL_ALLOWED_DOMAIN_SUFFIXES) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) {
      return true;
    }
  }

  return false;
};
