import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
  resolveThreadReplyFooterContext,
  type ThreadReplyFooterRecord,
} from '@roomote/communication';
import { deliverManagedThreadReplyFooter as deliverSharedThreadReplyFooter } from '@roomote/communication/thread-reply-footer-delivery';
import { Env } from '@roomote/env';

import {
  buildThreadReplyImages,
  errorResponseForThreadReplyImageError,
  type ThreadReplyImage,
} from './chat-reply-helpers';

export type CommunicationReplyTaskRun = {
  id: number;
  taskId: string;
  prRepo?: string | null;
  prNumber?: number | null;
  payload: unknown;
};

export type ParsedThreadReplyBody = {
  text?: string;
  images: Array<{ artifactId: string }>;
  /**
   * Caller-minted per-invocation send id: every HTTP retry of one tool call
   * carries the same value, so providers with idempotent sends (email) can
   * dedupe the logical send without depending on mutable route state.
   */
  clientSendId?: string;
};

type CommunicationThreadReplyProvider = 'discord' | 'telegram' | 'teams';

type PostedFooterRecord<T extends { messageId: string }> = T & {
  textWithoutFooter: string;
  images?: ThreadReplyFooterRecord['images'];
  refresh?: ThreadReplyFooterRecord['refresh'];
};

function getThreadReplyWebPath(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const webPath = (payload as { webPath?: unknown }).webPath;

  if (typeof webPath !== 'string' || !webPath.startsWith('/')) {
    return null;
  }

  return webPath;
}

function isSetupThreadReplyPayload(payload: unknown): boolean {
  return getThreadReplyWebPath(payload) === '/setup';
}

function buildThreadReplyTaskUrl(
  provider: CommunicationThreadReplyProvider,
  taskId: string,
): string {
  const url = new URL(`${Env.R_APP_URL}/task/${taskId}`);

  url.searchParams.set('utm_source', provider);
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', `${provider}.thread_reply`);

  return url.toString();
}

export async function buildCommunicationThreadReplyFooterText(params: {
  provider: CommunicationThreadReplyProvider;
  taskRun: CommunicationReplyTaskRun;
}): Promise<string | null> {
  if (isSetupThreadReplyPayload(params.taskRun.payload)) {
    return null;
  }

  const context = await resolveThreadReplyFooterContext({
    taskId: params.taskRun.taskId,
    prRepo: params.taskRun.prRepo ?? null,
    prNumber: params.taskRun.prNumber ?? null,
  });

  return buildThreadReplyFooterText({
    taskUrl: buildThreadReplyTaskUrl(params.provider, params.taskRun.taskId),
    ...context,
    formatLink: formatMarkdownLink,
    ...(params.provider === 'discord'
      ? { formatFooterText: (text: string) => `-# ${text}` }
      : {}),
  });
}

export async function buildCommunicationThreadReplyFooterTextBestEffort(params: {
  provider: CommunicationThreadReplyProvider;
  providerLabel: string;
  taskRun: CommunicationReplyTaskRun;
  logContext: string;
}): Promise<string | null> {
  try {
    return await buildCommunicationThreadReplyFooterText(params);
  } catch (error) {
    console.error(
      `[${params.logContext}] Failed to build ${params.providerLabel} reply footer for task run ${params.taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function getCommunicationReplyImages(params: {
  taskRun: Pick<CommunicationReplyTaskRun, 'id' | 'taskId'>;
  parsedBody: ParsedThreadReplyBody;
}): Promise<{
  images: ThreadReplyImage[];
  errorResponse: Response | null;
}> {
  const artifactIds = [
    ...new Set(params.parsedBody.images.map((image) => image.artifactId)),
  ];

  try {
    return {
      images: await buildThreadReplyImages({
        artifactIds,
        taskRun: params.taskRun,
      }),
      errorResponse: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorResponse = errorResponseForThreadReplyImageError(message);

    if (errorResponse) {
      return {
        images: [],
        errorResponse,
      };
    }

    throw error;
  }
}

export async function deliverManagedThreadReplyFooter<
  TReply extends { messageId: string },
>(params: {
  provider: CommunicationThreadReplyProvider;
  providerLabel: string;
  channelId: string;
  footerStateThreadId: string;
  lockKey: string;
  runId: number;
  logContext: string;
  postReplyWithFooter: () => Promise<PostedFooterRecord<TReply>>;
  clearPreviousFooter: (
    previousFooterRecord: ThreadReplyFooterRecord,
  ) => Promise<void>;
}): Promise<TReply> {
  const { runId, ...delivery } = params;
  return deliverSharedThreadReplyFooter({
    ...delivery,
    logRef: `task run ${runId}`,
  });
}
