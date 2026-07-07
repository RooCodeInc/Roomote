import {
  type ClaimedOutOfBandTaskMessage,
  claimPendingOutOfBandTaskMessages,
  releaseClaimedOutOfBandTaskMessages,
} from '@roomote/db/server';
import { wrapOutOfBandContext } from '@roomote/types';

export interface ClaimedOutOfBandContext {
  /** Prompt block to prepend to the user's message. */
  contextBlock: string;
  /** Claimed transcript row ids, for release if delivery fails. */
  messageIds: string[];
}

/**
 * Claims the task's pending out-of-band transcript messages (e.g. PR
 * review-feedback notifications persisted while the session was idle) and
 * formats them into the context block that must precede the user's next
 * prompt so the resumed harness knows what the user is replying to.
 *
 * Best-effort: returns null on error so a claim failure never blocks the
 * user's message. Call {@link releaseOutOfBandContext} if the message send
 * fails after a successful claim.
 */
export async function claimOutOfBandContextForPrompt(
  taskId: string,
): Promise<ClaimedOutOfBandContext | null> {
  let claimed: ClaimedOutOfBandTaskMessage[];

  try {
    claimed = await claimPendingOutOfBandTaskMessages(taskId);
  } catch (error) {
    console.warn(
      `[outOfBandContext] Failed to claim out-of-band messages for task ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }

  const contextBlock = wrapOutOfBandContext(
    claimed.map((message) => ({ sentAtMs: message.ts, text: message.text })),
  );

  if (!contextBlock) {
    // Nothing usable to inject: release any claimed rows so they are not
    // stranded as consumed-but-never-delivered.
    if (claimed.length > 0) {
      await releaseOutOfBandContext({
        contextBlock: '',
        messageIds: claimed.map((message) => message.id),
      });
    }

    return null;
  }

  return {
    contextBlock,
    messageIds: claimed.map((message) => message.id),
  };
}

/** Best-effort release of a claim whose prompt delivery failed. */
export async function releaseOutOfBandContext(
  context: ClaimedOutOfBandContext | null,
): Promise<void> {
  if (!context) {
    return;
  }

  try {
    await releaseClaimedOutOfBandTaskMessages(context.messageIds);
  } catch (error) {
    console.warn(
      `[outOfBandContext] Failed to release claimed out-of-band messages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Prepends the claimed context block to the user's prompt text. */
export function withOutOfBandContext(
  context: ClaimedOutOfBandContext | null,
  prompt: string,
): string {
  return context ? `${context.contextBlock}\n\n${prompt}` : prompt;
}
