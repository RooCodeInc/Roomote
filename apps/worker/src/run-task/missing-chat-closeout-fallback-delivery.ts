import { sdk } from '@roomote/sdk/client';

import { replyToChatThread } from '../mcp/roomote-mcp-server/chat-api-client';
import type { HarnessLogger } from '../logging';
import { getChatFallbackDeliveryConfig } from './chat-fallback-delivery-config';

export const EMPTY_CHAT_CLOSEOUT_FALLBACK_TEXT =
  'Roomote finished this turn without producing a final response. Reply here to continue or open the task for details.';

export async function deliverMissingChatCloseoutFallback(input: {
  runId: number;
  completionId: string;
  text: string | null | undefined;
  mcpTaskEnv?: Record<string, string>;
  logger: HarnessLogger;
}): Promise<void> {
  const config = getChatFallbackDeliveryConfig(input.mcpTaskEnv);
  if (!config) {
    return;
  }

  let claimed: boolean;

  try {
    ({ claimed } = await sdk.taskRuns.claimMissingChatCloseoutFallbackDelivery({
      runId: input.runId,
      completionId: input.completionId,
    }));
  } catch (error) {
    input.logger.warn(
      `[missingChatCloseoutFallback] Failed to claim chat fallback delivery for task run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (!claimed) {
    return;
  }

  const text = input.text?.trim() || EMPTY_CHAT_CLOSEOUT_FALLBACK_TEXT;

  try {
    await replyToChatThread(config, { text });
  } catch (error) {
    await sdk.taskRuns
      .releaseMissingChatCloseoutFallbackDelivery({
        runId: input.runId,
        completionId: input.completionId,
      })
      .catch((releaseError: unknown) => {
        input.logger.warn(
          `[missingChatCloseoutFallback] Failed to release delivery claim for task run ${input.runId}: ${
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError)
          }`,
        );
      });

    input.logger.warn(
      `[missingChatCloseoutFallback] Failed to post chat fallback for task run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
