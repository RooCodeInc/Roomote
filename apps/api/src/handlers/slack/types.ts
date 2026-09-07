import type {
  SlackEntityDetailsRequestedEvent,
  SlackEvent,
  SlackFunctionExecutedEvent,
  SlackLinkSharedEvent,
  SlackMemberJoinedChannelEvent,
  SlackReactionAddedEvent,
} from '@roomote/slack';

export interface SlackWebhookBody {
  type: string;
  challenge?: string;
  event?: SlackWebhookEvent;
  team_id?: string;
  event_id?: string;
  payload?: string;
}

export type SlackWebhookEvent =
  | SlackEvent
  | SlackFunctionExecutedEvent
  | SlackLinkSharedEvent
  | SlackEntityDetailsRequestedEvent
  | SlackMemberJoinedChannelEvent
  | SlackReactionAddedEvent;

export type AutomatedSlackAppMentionEvent = SlackEvent & {
  type: 'app_mention' | 'message';
  app_id: string;
};
