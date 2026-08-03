import { reactionEmojiMatches } from '@roomote/communication/reaction-emoji';
import { getAutomationRuntime } from '@roomote/db/server';

export const CALL_ROOMOTE_VIA_EMOJI_PROMPT = 'Act on this';

type CallRoomoteViaEmojiConfiguration = {
  emoji: string;
  prompt: string;
};

export async function getCallRoomoteViaEmojiConfiguration(
  receivedEmoji: string,
): Promise<CallRoomoteViaEmojiConfiguration | null> {
  const automation = await getAutomationRuntime('call_roomote_via_emoji');
  const emoji =
    typeof automation.settings.emoji === 'string'
      ? automation.settings.emoji.trim()
      : '';

  if (
    !automation.enabled ||
    !emoji ||
    !reactionEmojiMatches(emoji, receivedEmoji)
  ) {
    return null;
  }

  const instructions = automation.instructions?.trim();

  return {
    emoji,
    prompt: instructions
      ? `${CALL_ROOMOTE_VIA_EMOJI_PROMPT}\n\nAdditional instructions:\n${instructions}`
      : CALL_ROOMOTE_VIA_EMOJI_PROMPT,
  };
}
