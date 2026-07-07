import { PRODUCT_NAME } from '@roomote/types';
import { Env } from '@roomote/env';

import type {
  TaskUnfurlData,
  WorkObjectEntity,
  WorkObjectUnfurl,
  WorkObjectMetadataEntity,
  WorkObjectMetadata,
} from './types';

const TASK_URL_PATH_PREFIX = '/task/' as const;

function getProductIconUrl(): string {
  return `${Env.ROOMOTE_APP_URL}/android-chrome-192x192.png`;
}

/**
 * Extracts a task ID from a Roomote task URL.
 *
 * This validates the URL using the WHATWG {@link URL} parser to ensure the
 * structure matches the expected `https://app.roomote.example/task/{taskId}`
 * pattern. Trailing slashes after the task ID are allowed and ignored.
 *
 * The extracted `taskId` segment is returned as-is without additional
 * validation.
 *
 * @example
 * ```ts
 * extractTaskIdFromUrl('https://app.roomote.example/task/abc123');
 * // => 'abc123'
 *
 * extractTaskIdFromUrl('https://app.roomote.example/task/abc123/');
 * // => 'abc123'
 *
 * extractTaskIdFromUrl('https://app.roomote.example/other/abc123');
 * // => null
 * ```
 *
 * @param url - Candidate task URL.
 * @returns The task ID string when the URL matches the expected pattern;
 *          otherwise `null`.
 */
export function extractTaskIdFromUrl(url: string): string | null {
  if (!url) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!parsed.pathname.startsWith(TASK_URL_PATH_PREFIX)) {
    return null;
  }

  const taskId = parsed.pathname
    .slice(TASK_URL_PATH_PREFIX.length)
    .replace(/\/+$/, '');

  if (!taskId) {
    return null;
  }

  return taskId;
}

/**
 * Builds a Slack {@link WorkObjectEntity} from task unfurl data.
 *
 * This converts a domain-level {@link TaskUnfurlData} object into the
 * normalized Work Object entity structure understood by Slack. The
 * `product_icon` is set to a Roomote app icon URL.
 *
 * @example
 * ```ts
 * const entity = buildWorkObjectEntity({
 *   taskId: 'abc123',
 *   title: 'Review PR #42',
 *   status: CloudTaskStatus.Running,
 *   createdBy: 'alice',
 *   assignee: 'bob',
 *   createdAt: Date.now() - 1000,
 *   updatedAt: Date.now(),
 *   url: 'https://app.roomote.example/task/abc123',
 * });
 * ```
 *
 * @param data - Task unfurl data for the work object.
 * @returns A fully-typed {@link WorkObjectEntity}.
 */
export function buildWorkObjectEntity(data: TaskUnfurlData): WorkObjectEntity {
  const assigneeName = data.assignee ?? 'N/A';

  return {
    fields: {
      // Icon representing Roomote as the owning product for the task.
      product_icon: getProductIconUrl(),
      // Short description/title for the task. Use markdown so we can render
      // richer content when available.
      // description: {
      //   value: data.title,
      //   format: 'markdown',
      // },
      // User who created the task. When we have a Slack user ID, use it so
      // Slack can render a proper @mention. Fall back to text when no mapping.
      created_by: {
        user: data.createdBySlackUserId
          ? { user_id: data.createdBySlackUserId }
          : { text: data.createdBy },
        type: 'slack#/types/user',
      },
      // Timestamps are expressed as UNIX epoch seconds, matching Slack's
      // expected `timestamp` field semantics.
      date_created: { value: data.createdAt },
      // date_updated: {
      //   value: data.updatedAt,
      // },
      // Current assignee. As with `created_by`, we only have a display name,
      // so we use the `text` form.
      assignee: { user: { text: assigneeName }, type: 'slack#/types/user' },
    },
  } as const;
}

/**
 * Builds a complete Slack Work Object unfurl payload for a task URL.
 *
 * The returned structure uses a single `rich_text` block containing a
 * `rich_text_section` with one `work_object` element, which references the
 * provided {@link WorkObjectEntity} and the original task URL.
 *
 * @example
 * ```ts
 * const entity = buildWorkObjectEntity(taskData);
 *
 * const unfurl = buildWorkObjectUnfurl(
 *   taskData.url,
 *   taskData,
 *   entity,
 * );
 *
 * // unfurl.blocks[0].elements[0].elements[0].entity === entity
 * ```
 *
 * @param url - Original task URL being unfurled.
 * @param data - Task unfurl data containing the title and status.
 * @param _entity - Slack Work Object entity for the task (reserved for future use).
 * @returns A fully-typed {@link WorkObjectUnfurl} payload.
 */
export function buildWorkObjectUnfurl(
  url: string,
  data: TaskUnfurlData,
  _entity: WorkObjectEntity,
): WorkObjectUnfurl {
  return {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `<${url}|${data.title}>` },
      },
    ],
  } as const;
}

/**
 * Builds a single Work Object metadata entity entry for a Roomote task URL.
 *
 * This structure is embedded in the `metadata.entities` array passed to
 * Slack's `chat.unfurl` API so that Slack can register and render a Work
 * Object for the task. The display_order array controls which fields are
 * shown in the flexpane (side panel) when users click on the work object.
 */
export function buildWorkObjectMetadataEntity(
  appUnfurlUrl: string,
  data: TaskUnfurlData,
  entity: WorkObjectEntity,
): WorkObjectMetadataEntity {
  return {
    app_unfurl_url: appUnfurlUrl,
    url: data.url,
    external_ref: {
      id: data.taskId,
      type: 'task',
    },
    entity_type: 'slack#/entities/task',
    entity_payload: {
      attributes: {
        title: {
          text: data.title,
        },
        display_id: '',
        display_type: 'Task',
        product_name: PRODUCT_NAME,
        product_icon: {
          alt_text: `${PRODUCT_NAME} task`,
          url: getProductIconUrl(),
        },
      },
      fields: entity.fields,
      // Control which fields appear in the flexpane side panel
      display_order: ['created_by', 'assignee', 'date_created'],
    },
  };
}

/**
 * Wraps one or more Work Object metadata entities into the container object
 * expected by Slack's `metadata` parameter on `chat.unfurl`.
 */
export function buildWorkObjectMetadata(
  entities: WorkObjectMetadataEntity[],
): WorkObjectMetadata {
  return { entities };
}
