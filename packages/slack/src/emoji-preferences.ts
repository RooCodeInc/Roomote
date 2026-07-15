import {
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
  DEFAULT_SLACK_PR_CLOSED_EMOJI,
  getSlackEmojiPreferencesForDeployment as getSlackEmojiPreferencesForDeploymentFromDb,
  type SlackEmojiPreferences,
} from '@roomote/db/server';

export {
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
  DEFAULT_SLACK_PR_CLOSED_EMOJI,
  type SlackEmojiPreferences,
};

export async function getSlackEmojiPreferencesForDeployment() {
  return getSlackEmojiPreferencesForDeploymentFromDb();
}

export async function resolveSlackReactionNames(): Promise<{
  ackEmoji: string;
  completionEmoji: string;
  prClosedEmoji: string;
  summonEmoji: string | null;
}> {
  const preferences = await getSlackEmojiPreferencesForDeployment();

  return {
    ackEmoji: preferences.slackAckEmoji || DEFAULT_SLACK_ACK_EMOJI,
    completionEmoji:
      preferences.slackCompletionEmoji || DEFAULT_SLACK_COMPLETION_EMOJI,
    prClosedEmoji:
      preferences.slackPrClosedEmoji || DEFAULT_SLACK_PR_CLOSED_EMOJI,
    summonEmoji: preferences.slackSummonEmoji,
  };
}
