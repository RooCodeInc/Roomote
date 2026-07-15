import {
  DEFAULT_SLACK_ACK_EMOJI,
  DEFAULT_SLACK_COMPLETION_EMOJI,
} from '@roomote/types';

export { DEFAULT_SLACK_ACK_EMOJI, DEFAULT_SLACK_COMPLETION_EMOJI };

export async function resolveSlackReactionNames(): Promise<{
  ackEmoji: string;
  completionEmoji: string;
}> {
  return {
    ackEmoji: DEFAULT_SLACK_ACK_EMOJI,
    completionEmoji: DEFAULT_SLACK_COMPLETION_EMOJI,
  };
}
