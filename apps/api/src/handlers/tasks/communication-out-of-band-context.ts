/**
 * Re-surface out-of-band transcript messages (PR review / status
 * notifications) into non-Slack chat follow-ups.
 *
 * Slack already re-injects those notifications via the latest-bot-reply /
 * `<replying_to>` path in the Slack delivery tracker. Discord, Teams, and
 * Telegram only queue the user turn by default, so without this helper the
 * living agent session never learns what Roomote posted on its behalf while
 * the session was idle.
 */

import {
  claimPendingOutOfBandTaskMessages,
  releaseClaimedOutOfBandTaskMessages,
} from '@roomote/db/server';
import {
  wrapCommunicationMessage,
  wrapOutOfBandContext,
  type CommunicationProvider,
  type QueuedCommunicationMessage,
} from '@roomote/types';

export type ClaimedCommunicationOutOfBandContext = {
  messageIds: string[];
};

/**
 * Claims pending out-of-band task messages and, when present, sets
 * `formattedPrompt` to out-of-band context + the provider message wrapper.
 * Best-effort: a claim failure never blocks the user's message.
 */
export async function attachOutOfBandContextToCommunicationMessage(input: {
  taskId: string;
  provider: Exclude<CommunicationProvider, 'slack'>;
  message: QueuedCommunicationMessage;
}): Promise<{
  message: QueuedCommunicationMessage;
  claim: ClaimedCommunicationOutOfBandContext | null;
}> {
  let claimed;
  try {
    claimed = await claimPendingOutOfBandTaskMessages(input.taskId);
  } catch (error) {
    console.warn(
      `[communicationOutOfBand] Failed to claim out-of-band messages for task ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { message: input.message, claim: null };
  }

  const contextBlock = wrapOutOfBandContext(
    claimed.map((message) => ({ sentAtMs: message.ts, text: message.text })),
  );

  if (!contextBlock) {
    if (claimed.length > 0) {
      await releaseCommunicationOutOfBandClaim({
        messageIds: claimed.map((message) => message.id),
      });
    }
    return { message: input.message, claim: null };
  }

  const currentMessageBlock =
    input.message.formattedPrompt ??
    wrapCommunicationMessage(input.provider, input.message);

  return {
    message: {
      ...input.message,
      formattedPrompt: `${contextBlock}\n\n${currentMessageBlock}`,
    },
    claim: { messageIds: claimed.map((message) => message.id) },
  };
}

/** Best-effort release when queue/resume delivery fails after a claim. */
export async function releaseCommunicationOutOfBandClaim(
  claim: ClaimedCommunicationOutOfBandContext | null,
): Promise<void> {
  if (!claim || claim.messageIds.length === 0) {
    return;
  }

  try {
    await releaseClaimedOutOfBandTaskMessages(claim.messageIds);
  } catch (error) {
    console.warn(
      `[communicationOutOfBand] Failed to release claimed out-of-band messages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
