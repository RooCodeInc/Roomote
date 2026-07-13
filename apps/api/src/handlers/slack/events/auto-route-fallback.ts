import type { SlackInstallation, SlackUserMapping } from '@roomote/db/server';
import {
  showTaskConfiguration,
  type SlackEvent,
  type SlackNotifier,
  type StartAutoRoutedSlackTaskResult,
} from '@roomote/slack';

type SlackEventWithOptionalUser = Omit<SlackEvent, 'user'> & {
  user?: string;
};
type ManualPickerSlackInstallation = Pick<
  SlackInstallation,
  'botUserId' | 'teamId' | 'teamDomain'
>;
type ManualPickerUserMapping = Pick<SlackUserMapping, 'userId'>;

function shouldShowManualPickerForAutoRouteResult(
  result: StartAutoRoutedSlackTaskResult,
): boolean {
  return result.status === 'not_started' && result.code === 'routing_fallback';
}

export async function showManualPickerForAutoRouteFallback(params: {
  result: StartAutoRoutedSlackTaskResult;
  event: SlackEventWithOptionalUser;
  slackInstallation: ManualPickerSlackInstallation;
  userMapping: ManualPickerUserMapping | null;
  slack: SlackNotifier;
  processedImages?: string[];
  processedAttachmentTexts?: string[];
  processedVideoDescriptions?: string[];
  processingReactionName?: string;
}): Promise<boolean> {
  if (!shouldShowManualPickerForAutoRouteResult(params.result)) {
    return false;
  }

  if (!params.userMapping || !params.event.user) {
    return false;
  }

  const event: SlackEvent = {
    ...params.event,
    user: params.event.user,
    ...(params.processedImages
      ? { processedImages: params.processedImages }
      : {}),
    ...(params.processedAttachmentTexts
      ? { processedAttachmentTexts: params.processedAttachmentTexts }
      : {}),
    ...(params.processedVideoDescriptions
      ? { processedVideoDescriptions: params.processedVideoDescriptions }
      : {}),
  };

  await showTaskConfiguration({
    event,
    slackInstallation: params.slackInstallation as SlackInstallation,
    userMapping: params.userMapping as SlackUserMapping,
    slack: params.slack,
    skipRouting: true,
    skipMcpSetupSuggestion: true,
    processingReactionName: params.processingReactionName,
  });

  return true;
}
