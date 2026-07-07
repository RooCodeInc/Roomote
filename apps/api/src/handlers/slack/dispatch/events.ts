import type {
  SlackEntityDetailsRequestedEvent,
  SlackFunctionExecutedEvent,
  SlackLinkSharedEvent,
  SlackMemberJoinedChannelEvent,
  SlackReactionAddedEvent,
} from '@roomote/slack';

import type { SlackWebhookContext } from '../context.js';
import type { SlackWebhookEvent } from '../types.js';
import { processSlackWorkflowFunctionExecuted } from '../events/function-executed.js';
import { maybePostSlackChannelWelcome } from '../events/member-joined.js';
import { handleMessageOrAppMentionEvent } from '../events/message-entry.js';
import { handleReactionAddedEvent } from '../events/reactions.js';
import {
  handleEntityDetailsRequestedEvent,
  handleLinkSharedEvent,
} from '../events/work-objects.js';
import { apiLogger } from '../../../logging.js';

export async function dispatchSlackEvent(params: {
  event: SlackWebhookEvent;
  context: SlackWebhookContext;
}): Promise<void> {
  const { event, context } = params;

  switch (event.type) {
    case 'function_executed': {
      const functionEvent = event as SlackFunctionExecutedEvent;
      void processSlackWorkflowFunctionExecuted({
        functionEvent,
        context,
      }).catch((error) => {
        console.error(
          `[SlackWorkflow] Failed to finish background workflow processing for ${functionEvent.function_execution_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      return;
    }
    case 'reaction_added':
      await handleReactionAddedEvent({
        event: event as SlackReactionAddedEvent,
        context,
      });
      return;
    case 'member_joined_channel':
      await maybePostSlackChannelWelcome({
        event: event as SlackMemberJoinedChannelEvent,
        slackInstallation: context.slackInstallation,
        slack: context.slack,
      });
      return;
    case 'app_mention':
    case 'message':
      await handleMessageOrAppMentionEvent({
        event,
        context,
      });
      return;
    case 'link_shared':
      await handleLinkSharedEvent({
        event: event as SlackLinkSharedEvent,
        slack: context.slack,
        teamId: context.teamId,
      });
      return;
    case 'entity_details_requested':
      await handleEntityDetailsRequestedEvent({
        event: event as SlackEntityDetailsRequestedEvent,
        slack: context.slack,
      });
      return;
    default:
      apiLogger.debug(`Unhandled event type: ${event.type}`);
  }
}
