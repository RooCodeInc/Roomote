import {
  buildThreadReplyFooterText,
  buildThreadReplyPrUrl,
  resolveThreadReplyFooterContext,
  resolveThreadReplyLinkedPrs,
  resolveThreadReplyLivePreviewUrl,
  type ThreadReplyFooterContext,
  type ThreadReplyLinkedPr,
  type ThreadReplyRunningTasks,
} from '@roomote/communication';

import { isSlackThreadExplicitMentionRequired } from './slack-messages';

export type SlackThreadLinkedPr = ThreadReplyLinkedPr;

export interface SlackThreadFooterContext extends ThreadReplyFooterContext {
  explicitMentionRequired: boolean;
}

export {
  buildThreadReplyPrUrl as buildSlackThreadReplyPrUrl,
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
  linkedPrs?: SlackThreadLinkedPr[];
  livePreviewUrl?: string | null;
  runningTasks?: ThreadReplyRunningTasks | null;
  webAppUrl?: string | null;
  explicitMentionRequired: boolean;
}): string {
  return buildThreadReplyFooterText({
    taskUrl: params.taskUrl,
    linkedPrs: params.linkedPrs,
    livePreviewUrl: params.livePreviewUrl,
    runningTasks: params.runningTasks,
    webAppUrl: params.webAppUrl,
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
    linkedPrs: params.linkedPrs ?? context.linkedPrs,
    livePreviewUrl: context.livePreviewUrl,
    runningTasks: context.runningTasks,
    webAppUrl: context.webAppUrl,
    explicitMentionRequired: context.explicitMentionRequired,
  });
}
