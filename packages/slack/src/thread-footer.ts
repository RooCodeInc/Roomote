import {
  buildThreadReplyFooterText,
  buildThreadReplyPrUrl,
  resolveThreadReplyFooterContext,
  resolveThreadReplyLinkedPr,
  resolveThreadReplyLinkedPrs,
  resolveThreadReplyLivePreviewUrl,
  type ThreadReplyFooterContext,
  type ThreadReplyLinkedPr,
} from '@roomote/communication';

import { isSlackThreadExplicitMentionRequired } from './slack-messages';

export type SlackThreadLinkedPr = ThreadReplyLinkedPr;

export interface SlackThreadFooterContext extends ThreadReplyFooterContext {
  explicitMentionRequired: boolean;
}

export {
  buildThreadReplyPrUrl as buildSlackThreadReplyPrUrl,
  resolveThreadReplyLinkedPr as resolveSlackThreadLinkedPr,
  resolveThreadReplyLinkedPrs as resolveSlackThreadLinkedPrs,
  resolveThreadReplyLivePreviewUrl as resolveSlackThreadLivePreviewUrl,
};

export async function resolveSlackThreadFooterContext(params: {
  taskId: string | null | undefined;
  prRepo: string | null | undefined;
  prNumber: number | null | undefined;
  channelId: string;
  threadTs: string;
}): Promise<SlackThreadFooterContext> {
  const [context, explicitMentionRequired] = await Promise.all([
    resolveThreadReplyFooterContext(params),
    isSlackThreadExplicitMentionRequired(params.channelId, params.threadTs),
  ]);

  return {
    ...context,
    explicitMentionRequired,
  };
}

export function buildSlackThreadFooterText(params: {
  taskUrl: string;
  linkedPr: SlackThreadLinkedPr | null;
  linkedPrs?: SlackThreadLinkedPr[];
  livePreviewUrl?: string | null;
  explicitMentionRequired: boolean;
}): string {
  return buildThreadReplyFooterText({
    taskUrl: params.taskUrl,
    linkedPr: params.linkedPr,
    linkedPrs: params.linkedPrs,
    livePreviewUrl: params.livePreviewUrl,
    explicitMentionRequired: params.explicitMentionRequired,
    formatLink: (label, url) => `<${url}|${label}>`,
  });
}

export async function getSlackThreadFooterText(params: {
  taskUrl: string;
  taskId: string | null | undefined;
  prRepo: string | null | undefined;
  prNumber: number | null | undefined;
  linkedPrs?: SlackThreadLinkedPr[];
  channelId: string;
  threadTs: string;
}): Promise<string> {
  const context = await resolveSlackThreadFooterContext(params);

  return buildSlackThreadFooterText({
    taskUrl: params.taskUrl,
    linkedPr: context.linkedPr,
    linkedPrs: params.linkedPrs ?? context.linkedPrs,
    livePreviewUrl: context.livePreviewUrl,
    explicitMentionRequired: context.explicitMentionRequired,
  });
}
