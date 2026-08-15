import { sdk } from '@roomote/sdk/client';
import type { ShowWidgetFallbackDelivery } from '@roomote/types';

import { replyToChatThread } from '../mcp/roomote-mcp-server/chat-api-client';
import type { HarnessLogger } from '../logging';
import { getChatFallbackDeliveryConfig } from './chat-fallback-delivery-config';

export async function deliverShowWidgetFallback(input: {
  runId: number;
  delivery: ShowWidgetFallbackDelivery | null | undefined;
  mcpTaskEnv?: Record<string, string>;
  logger: HarnessLogger;
}): Promise<void> {
  const config = getChatFallbackDeliveryConfig(input.mcpTaskEnv);
  if (!input.delivery || !config) {
    return;
  }

  const claimInput = {
    runId: input.runId,
    toolCallId: input.delivery.toolCallId,
  };
  let claimed: boolean;

  try {
    ({ claimed } =
      await sdk.taskRuns.claimShowWidgetFallbackDelivery(claimInput));
  } catch (error) {
    input.logger.warn(
      `[showWidgetFallbackDelivery] Failed to claim chat fallback delivery for task run ${input.runId}, tool call ${input.delivery.toolCallId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (!claimed) {
    return;
  }

  const text = input.delivery.title
    ? `${input.delivery.title}\n\n${input.delivery.textFallback}`
    : input.delivery.textFallback;
  const message = `${text}\n\n[View widget](${input.delivery.widgetUrl})`;

  try {
    await replyToChatThread(config, { text: message });
  } catch (error) {
    await sdk.taskRuns
      .releaseShowWidgetFallbackDelivery(claimInput)
      .catch((releaseError: unknown) => {
        input.logger.warn(
          `[showWidgetFallbackDelivery] Failed to release delivery claim for task run ${input.runId}, tool call ${input.delivery?.toolCallId}: ${
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError)
          }`,
        );
      });

    input.logger.warn(
      `[showWidgetFallbackDelivery] Failed to post chat fallback for task run ${input.runId}, tool call ${input.delivery.toolCallId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
