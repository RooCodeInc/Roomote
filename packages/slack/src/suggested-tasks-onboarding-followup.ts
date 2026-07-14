import { SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_PROMPT_TEXT } from '@roomote/communication/chat-messages';
import { getRedis } from '@roomote/redis';
import type { SlackBlock } from '@roomote/types';

export const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CONFIGURE_ACTION_ID =
  'suggested_tasks_onboarding_followup_configure';
export const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_IGNORE_ACTION_ID =
  'suggested_tasks_onboarding_followup_ignore';

export const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT =
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_PROMPT_TEXT;

const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_PREFIX =
  'slack:suggested-tasks-onboarding-followup:';
const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_SENT_PREFIX =
  'slack:suggested-tasks-onboarding-followup:sent:';
const SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TTL_SECONDS = 30 * 24 * 60 * 60;

const CLAIM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
local ok, data = pcall(cjson.decode, val)
if not ok then return nil end
if data.nonce ~= ARGV[1] then return nil end
if data.slackUserId ~= ARGV[2] then return nil end
redis.call('del', KEYS[1])
return val
`;

export interface PendingSuggestedTasksOnboardingFollowupPrompt {
  slackTeamId: string;
  slackUserId: string;
  channelId: string;
  threadTs: string;
  nonce: string;
  settingsUrl: string;
}

export interface SuggestedTasksOnboardingFollowupPromptSentMarker {
  channelId: string;
  messageTs: string;
  promptSentAt: string;
  pendingPrompt: PendingSuggestedTasksOnboardingFollowupPrompt;
}

function getSuggestedTasksOnboardingFollowupKey(threadId: string): string {
  return `${SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_PREFIX}${threadId}`;
}

function getSuggestedTasksOnboardingFollowupSentKey(threadId: string): string {
  return `${SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_SENT_PREFIX}${threadId}`;
}

export function buildSuggestedTasksOnboardingFollowupPromptBlocks(params: {
  settingsUrl: string;
  nonce: string;
}): SlackBlock[] {
  return [
    {
      type: 'markdown',
      text: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
    },
    {
      type: 'actions',
      block_id: 'suggested_tasks_onboarding_followup',
      elements: [
        {
          type: 'button',
          action_id: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_CONFIGURE_ACTION_ID,
          text: {
            type: 'plain_text',
            text: 'Configure',
            emoji: false,
          },
          url: params.settingsUrl,
          style: 'primary',
          value: params.nonce,
        },
        {
          type: 'button',
          action_id: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_IGNORE_ACTION_ID,
          text: {
            type: 'plain_text',
            text: 'No, thanks',
            emoji: false,
          },
          value: params.nonce,
        },
      ],
    },
  ];
}

export function buildSuggestedTasksOnboardingFollowupPromptTextBlocks(): SlackBlock[] {
  return [
    {
      type: 'markdown',
      text: SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TEXT,
    },
  ];
}

export function buildSuggestedTasksOnboardingFollowupIgnoreBlocks(
  settingsUrl: string,
): SlackBlock[] {
  return [
    {
      type: 'markdown',
      text: `OK. If you change their mind, you can [do it here](${settingsUrl}).`,
    },
  ];
}

export async function setPendingSuggestedTasksOnboardingFollowupPrompt(params: {
  threadId: string;
  payload: PendingSuggestedTasksOnboardingFollowupPrompt;
}): Promise<void> {
  await getRedis().set(
    getSuggestedTasksOnboardingFollowupKey(params.threadId),
    JSON.stringify(params.payload),
    'EX',
    SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TTL_SECONDS,
  );
}

export async function clearPendingSuggestedTasksOnboardingFollowupPrompt(
  threadId: string,
): Promise<void> {
  await getRedis().del(getSuggestedTasksOnboardingFollowupKey(threadId));
}

export async function getPendingSuggestedTasksOnboardingFollowupPromptWithNonce(params: {
  threadId: string;
  expectedNonce: string;
  expectedSlackUserId: string;
}): Promise<PendingSuggestedTasksOnboardingFollowupPrompt | null> {
  const value = await getRedis().get(
    getSuggestedTasksOnboardingFollowupKey(params.threadId),
  );

  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      value,
    ) as PendingSuggestedTasksOnboardingFollowupPrompt;

    if (
      parsed.nonce !== params.expectedNonce ||
      parsed.slackUserId !== params.expectedSlackUserId
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function claimPendingSuggestedTasksOnboardingFollowupPromptWithNonce(params: {
  threadId: string;
  expectedNonce: string;
  expectedSlackUserId: string;
}): Promise<PendingSuggestedTasksOnboardingFollowupPrompt | null> {
  const claimed = (await getRedis().eval(
    CLAIM_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_LUA,
    1,
    getSuggestedTasksOnboardingFollowupKey(params.threadId),
    params.expectedNonce,
    params.expectedSlackUserId,
  )) as string | null;

  if (!claimed) {
    return null;
  }

  try {
    return JSON.parse(claimed) as PendingSuggestedTasksOnboardingFollowupPrompt;
  } catch {
    return null;
  }
}

export async function setSuggestedTasksOnboardingFollowupPromptSentMarker(params: {
  threadId: string;
  marker: SuggestedTasksOnboardingFollowupPromptSentMarker;
}): Promise<void> {
  await getRedis().set(
    getSuggestedTasksOnboardingFollowupSentKey(params.threadId),
    JSON.stringify(params.marker),
    'EX',
    SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_TTL_SECONDS,
  );
}

export async function getSuggestedTasksOnboardingFollowupPromptSentMarker(
  threadId: string,
): Promise<SuggestedTasksOnboardingFollowupPromptSentMarker | null> {
  const value = await getRedis().get(
    getSuggestedTasksOnboardingFollowupSentKey(threadId),
  );

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(
      value,
    ) as SuggestedTasksOnboardingFollowupPromptSentMarker;
  } catch {
    return null;
  }
}
