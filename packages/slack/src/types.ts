export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  url_private_download: string;
  size: number;
}

export interface SlackMessage {
  channel?: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  metadata?: SlackMessageMetadata;
}

export interface SlackResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  message_ts?: string;
  error?: string;
  message?: Record<string, unknown>;
}

/**
 * Structured outcome of a chat.postMessage attempt. Exactly one of the
 * fields is set: `ts` on success, otherwise the failure discriminator.
 */
export interface SlackPostMessageResult {
  ts?: string;
  /** Slack API error code (e.g. `not_in_channel`) when Slack rejected the post. */
  slackErrorCode?: string;
  /** The HTTP call itself failed (non-2xx status or network error); retryable. */
  transportError?: boolean;
  /** Threaded reply skipped because the thread root message no longer exists. */
  skippedMissingThreadRoot?: boolean;
}

export interface SlackMessageMetadata {
  event_type: string;
  event_payload: Record<string, unknown>;
}

export interface SlackThreadMessage {
  user: string;
  username?: string; // Display name fetched from Slack API, fallback to user ID if not available
  text: string;
  authoredText?: string;
  ts: string;
  bot_id?: string;
  type: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: SlackFile[];
}

export interface SlackChannelMessage extends SlackThreadMessage {
  thread_ts?: string;
}

export interface SlackConversationMessage {
  text: string;
  authoredText?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: SlackFile[];
}

export interface SlackUserInfo {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name: string;
    profile: {
      display_name: string;
      real_name: string;
      title?: string;
      email?: string;
    };
  };
  error?: string;
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  user: string;
  text: string;
  authoredText?: string;
  ts: string;
  /** Internal turn ID when an event is synthesized from another Slack event. */
  deliveryTs?: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
  blocks?: unknown[];
  files?: SlackFile[];
  attachments?: unknown[];
  processedImages?: string[];
  processedAttachmentTexts?: string[];
  processedVideoDescriptions?: string[];
  channel_type?: string;
  /** Captured once at routing time so Slack interactions do not refetch it. */
  statuspageWarningText?: string;
}

export type SlackFunctionExecutionInput =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface SlackFunctionExecutedEvent {
  type: 'function_executed';
  function_execution_id: string;
  bot_access_token: string;
  event_ts?: string;
  function: {
    callback_id: string;
  };
  inputs: Record<string, SlackFunctionExecutionInput>;
}

export type SlackInteractiveAction =
  | {
      type: 'static_select';
      action_id?: string;
      selected_option: {
        text: { text: string };
        value: string;
      } | null;
    }
  | {
      type: 'radio_buttons';
      action_id?: string;
      selected_option: {
        text: { text: string };
        value: string;
      } | null;
    }
  | {
      type: 'button';
      action_id?: string;
      text: { text: string };
      value: string | null;
    };

export interface SlackInteractivePayload {
  type: string;
  team: {
    id: string;
    domain: string;
  };
  user: {
    id: string;
    name: string;
  };
  channel: {
    id: string;
    name: string;
  };
  message: {
    ts: string;
    thread_ts?: string;
    blocks?: unknown[];
  };
  container?: {
    message_ts?: string;
    thread_ts?: string;
  };
  actions: SlackInteractiveAction[];
  state: {
    values: Record<string, Record<string, SlackInteractiveAction>>;
  };
  response_url: string;
  trigger_id: string;
}

/**
 * Slack `link_shared` event payload.
 *
 * Extends the base SlackEvent with link metadata for URLs that have been
 * shared in a channel, which is used as the entry point for building
 * unfurls and Work Object previews.
 */
export interface SlackLinkSharedEvent extends SlackEvent {
  type: 'link_shared';
  /**
   * Timestamp of the message that contained the shared links.
   *
   * Note: For `link_shared` events Slack uses `message_ts` instead of `ts` to
   * reference the original message. This is the value that must be passed to
   * `chat.unfurl`.
   */
  message_ts: string;
  links: {
    domain: string;
    url: string;
  }[];
}

/**
 * Slack `entity_details_requested` event payload.
 *
 * This event is fired when a user clicks on a Work Object in Slack's flexpane
 * to view more details. The handler should respond by calling the entities.update
 * API with fresh entity data.
 */
export interface SlackEntityDetailsRequestedEvent extends SlackEvent {
  type: 'entity_details_requested';
  trigger_id: string;
  external_ref: {
    id: string;
    type: string;
  };
}

/**
 * Slack `member_joined_channel` event payload.
 *
 * Triggered when a member joins a channel. Roomote uses this to detect when
 * the installed bot user is added to a new channel for the first time.
 */
export interface SlackMemberJoinedChannelEvent {
  type: 'member_joined_channel';
  channel: string;
  user: string;
  channel_type?: string;
  inviter?: string;
  event_ts: string;
  team?: string;
}

/**
 * Slack `reaction_added` event payload.
 *
 * Triggered when a user adds a reaction to a message. Used for
 * reaction-driven automations (for example suggestion execution).
 */
export interface SlackReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: 'message';
    channel: string;
    ts: string;
  };
  item_user?: string;
  event_ts: string;
}

/**
 * Data required to construct a task unfurl for Slack Work Objects.
 *
 * This represents the domain-specific task information that is mapped onto
 * a Slack Work Object entity before being sent as part of an unfurl.
 */
export interface TaskUnfurlData {
  taskId: string;
  title: string;
  status: string;
  createdBy: string;
  /**
   * Slack user ID of the creator when a mapping exists.
   * If present, Slack can render a proper @mention instead of plain text.
   */
  createdBySlackUserId?: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
  url: string;
}

interface SlackWorkObjectUser {
  /**
   * Slack user ID (e.g. `U123ABC456`). When provided, this is the
   * canonical identifier for the user.
   */
  user_id?: string;
  /**
   * Fallback display name when a Slack user ID is not available.
   */
  text?: string;
  /**
   * Optional email address for additional context.
   */
  email?: string;
}

export interface SlackWorkObjectUserField {
  user: SlackWorkObjectUser;
  type: 'slack#/types/user';
}

export interface SlackWorkObjectDescriptionField {
  /**
   * Display text shown in the Work Object field.
   */
  value: string;
  /**
   * Optional formatting hint for Slack. Defaults to plain text when
   * omitted.
   */
  format?: 'markdown' | 'plain_text';
}

export interface SlackWorkObjectTimestampField {
  /**
   * UNIX timestamp value (in seconds).
   */
  value: number;
}

export interface SlackWorkObjectStatusField {
  /**
   * Human-readable status label (e.g. `open`, `Completed`).
   */
  value: string;
  /**
   * Optional tag color used for the colored status chip.
   */
  tag_color?: string;
  /**
   * Optional URL to open when the status chip is clicked.
   */
  link?: string;
}

type SlackWorkObjectDateFieldType =
  | 'slack#/types/date'
  | 'slack#/types/timestamp';

export interface SlackWorkObjectDateField {
  /**
   * Date value – either a `YYYY-MM-DD` string (for `date`) or a UNIX
   * timestamp (for `timestamp`).
   */
  value: string | number;
  type: SlackWorkObjectDateFieldType;
}

interface SlackWorkObjectPriorityIcon {
  /**
   * Alt text for the icon.
   */
  alt_text: string;
  /**
   * Publicly-accessible URL for the icon image.
   */
  url: string;
}

export interface SlackWorkObjectPriorityField {
  /**
   * Priority label (e.g. `high`, `medium`, `low`).
   */
  value: string;
  /**
   * Optional icon rendered to the left of the text.
   */
  icon?: SlackWorkObjectPriorityIcon;
  /**
   * Optional link opened when the priority field is clicked.
   */
  link?: string;
}

/**
 * Slack Work Object entity payload for a task.
 *
 * This mirrors Slack's documented `entity_payload` structure for a
 * `slack#/entities/task` Work Object. It is used inside the Work Objects
 * `metadata.entities[].entity_payload` container passed to `chat.unfurl`.
 */
export interface WorkObjectEntity {
  /**
   * Structured Work Object fields that Slack expects in the entity payload.
   * Each key maps to a strongly-typed field configuration.
   */
  fields: {
    /**
     * Short task description or title.
     */
    description?: SlackWorkObjectDescriptionField;
    /**
     * User who created the task.
     */
    created_by?: SlackWorkObjectUserField;
    /**
     * Task creation time.
     */
    date_created?: SlackWorkObjectTimestampField;
    /**
     * Task last-updated time.
     */
    date_updated?: SlackWorkObjectTimestampField;
    /**
     * Current assignee for the task.
     */
    assignee?: SlackWorkObjectUserField;
    /**
     * Current status of the task.
     */
    status?: SlackWorkObjectStatusField;
    /**
     * Optional due date for the task.
     */
    due_date?: SlackWorkObjectDateField;
    /**
     * Optional priority field with icon and link.
     */
    priority?: SlackWorkObjectPriorityField;
    /**
     * Optional product icon for the task (Roomote app icon URL).
     */
    product_icon?: string;
    /**
     * Allow for additional provider-specific fields.
     */
    [key: string]: unknown;
  };
}

/**
 * Attributes section for a Slack Work Object entity payload.
 *
 * This reflects the common fields used in `entity_payload.attributes` for
 * task entities.
 */
export interface WorkObjectEntityAttributes {
  title: {
    text: string;
  };
  display_id?: string;
  display_type?: string;
  product_name?: string;
  product_icon?: {
    alt_text: string;
    url: string;
  };
}

/**
 * Single Work Object entity metadata entry used in the `metadata.entities`
 * array for `chat.unfurl`.
 */
export interface WorkObjectMetadataEntity {
  app_unfurl_url?: string;
  url: string;
  triggerId?: string;
  external_ref: {
    id: string;
    type?: string;
  };
  entity_type: 'slack#/entities/task';
  entity_payload: {
    attributes: WorkObjectEntityAttributes;
    fields: WorkObjectEntity['fields'];
    custom_fields?: unknown[];
    display_order?: string[];
  };
}

/**
 * Container type for the Work Object metadata passed to `chat.unfurl`.
 */
export interface WorkObjectMetadata {
  entities: WorkObjectMetadataEntity[];
}

/**
 * Unfurl payload for displaying a Roomote task in the Slack message.
 *
 * This structure is used as the value in the `unfurls` map for
 * `chat.unfurl`. The Work Object definition itself is carried separately in
 * the `metadata.entities` payload.
 */
export interface WorkObjectUnfurl {
  blocks: {
    type: 'section';
    text: {
      type: 'mrkdwn';
      text: string;
    };
  }[];
}
