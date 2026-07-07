import { PRODUCT_NAME, formatErrorForLog } from '@roomote/types';
import type {
  SlackEntityDetailsRequestedEvent,
  SlackLinkSharedEvent,
  SlackNotifier,
} from '@roomote/slack';
import {
  buildWorkObjectEntity,
  buildWorkObjectMetadata,
  buildWorkObjectMetadataEntity,
  buildWorkObjectUnfurl,
  extractTaskIdFromUrl,
  fetchTaskDataForUnfurl,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';
import { isAllowedUnfurlDomain } from '../constants.js';

export async function handleLinkSharedEvent(params: {
  event: SlackLinkSharedEvent;
  slack: SlackNotifier;
  teamId: string;
}): Promise<void> {
  const { event, slack, teamId } = params;

  if (!event.links || event.links.length === 0) {
    apiLogger.debug('[SlackWebhook] link_shared event with no links');
    return;
  }

  try {
    const unfurls: Record<
      string,
      ReturnType<typeof buildWorkObjectUnfurl>
    > = {};
    const metadataEntities: ReturnType<typeof buildWorkObjectMetadataEntity>[] =
      [];

    for (const link of event.links) {
      if (!isAllowedUnfurlDomain(link.domain)) {
        continue;
      }

      const taskId = extractTaskIdFromUrl(link.url);

      if (!taskId) {
        apiLogger.debug(
          `[SlackWebhook] Skipping non-task ${PRODUCT_NAME} URL in link_shared event: ${link.url}`,
        );
        continue;
      }

      const taskData = await fetchTaskDataForUnfurl(taskId);

      if (!taskData) {
        apiLogger.debug(
          `[SlackWebhook] No task data found or unauthorized for unfurl: taskId=${taskId} url=${link.url}`,
        );
        continue;
      }

      const entity = buildWorkObjectEntity(taskData);
      const unfurl = buildWorkObjectUnfurl(link.url, taskData, entity);

      const metadataEntity = buildWorkObjectMetadataEntity(
        link.url,
        taskData,
        entity,
      );

      unfurls[link.url] = unfurl;
      metadataEntities.push(metadataEntity);
    }

    const unfurlCount = Object.keys(unfurls).length;

    if (unfurlCount > 0) {
      const metadata = buildWorkObjectMetadata(metadataEntities);

      await slack.unfurlTaskUrl({
        channel: event.channel,
        messageTs: event.message_ts,
        unfurls,
        metadata,
      });

      apiLogger.debug(
        `[SlackWebhook] Successfully unfurled ${unfurlCount} ${PRODUCT_NAME} task URL(s) for message ${event.message_ts} in channel ${event.channel}`,
      );
    } else {
      apiLogger.debug(
        `[SlackWebhook] No valid ${PRODUCT_NAME} task URLs found to unfurl in link_shared event`,
      );
    }
  } catch (error) {
    console.error(
      `[SlackWebhook] Failed to process link_shared event for Work Object unfurls: channel=${event.channel} messageTs=${event.message_ts} teamId=${teamId} error=${formatErrorForLog(error)}`,
    );
  }
}

export async function handleEntityDetailsRequestedEvent(params: {
  event: SlackEntityDetailsRequestedEvent;
  slack: SlackNotifier;
}): Promise<void> {
  const { event, slack } = params;

  if (!event.external_ref?.id) {
    apiLogger.debug(
      '[SlackWebhook] entity_details_requested event with no entity ID',
    );
    return;
  }

  try {
    const taskId = event.external_ref.id;

    const taskData = await fetchTaskDataForUnfurl(taskId);

    if (!taskData) {
      apiLogger.debug(
        `[SlackWebhook] No task data found or unauthorized for entity details: taskId=${taskId} triggerId=${event.trigger_id}`,
      );
      return;
    }

    const entity = buildWorkObjectEntity(taskData);
    const metadataEntity = buildWorkObjectMetadataEntity(
      taskData.url,
      taskData,
      entity,
    );

    await slack.updateEntity({
      triggerId: event.trigger_id,
      metadata: metadataEntity,
    });

    apiLogger.debug(
      `[SlackWebhook] Successfully updated entity details for task ${taskId}`,
    );
  } catch (error) {
    console.error(
      `[SlackWebhook] Failed to process entity_details_requested event: triggerId=${event.trigger_id} error=${formatErrorForLog(error)}`,
    );
  }
}
