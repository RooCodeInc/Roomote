import {
  buildThreadReplyFooterText,
  formatMarkdownLink,
  getThreadReplyFooterRecord,
  resolveThreadReplyFooterContext,
  setThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
} from '@roomote/communication';
import { Env } from '@roomote/env';

import {
  buildThreadReplyImages,
  errorResponseForThreadReplyImageError,
  type ThreadReplyImage,
  withThreadReplyFooterLock,
} from './chat-reply-helpers';

export type CommunicationReplyCloudJob = {
  id: number;
  taskId: string;
  prRepo?: string | null;
  prNumber?: number | null;
  payload: unknown;
};

export type ParsedThreadReplyBody = {
  text?: string;
  images: Array<{ artifactId: string }>;
};

type CommunicationThreadReplyProvider = 'telegram' | 'teams';

type PostedFooterRecord<T extends { messageId: string }> = T & {
  textWithoutFooter: string;
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
  const url = new URL(`${Env.ROOMOTE_APP_URL}/task/${taskId}`);

  url.searchParams.set('utm_source', provider);
  url.searchParams.set('utm_medium', 'link');
  url.searchParams.set('utm_campaign', `${provider}.thread_reply`);

  return url.toString();
}

async function buildCommunicationThreadReplyFooterText(params: {
  provider: CommunicationThreadReplyProvider;
  cloudJob: CommunicationReplyCloudJob;
}): Promise<string | null> {
  if (isSetupThreadReplyPayload(params.cloudJob.payload)) {
    return null;
  }

  const context = await resolveThreadReplyFooterContext({
    taskId: params.cloudJob.taskId,
    prRepo: params.cloudJob.prRepo ?? null,
    prNumber: params.cloudJob.prNumber ?? null,
  });

  return buildThreadReplyFooterText({
    taskUrl: buildThreadReplyTaskUrl(params.provider, params.cloudJob.taskId),
    ...context,
    formatLink: formatMarkdownLink,
  });
}

export async function buildCommunicationThreadReplyFooterTextBestEffort(params: {
  provider: CommunicationThreadReplyProvider;
  providerLabel: string;
  cloudJob: CommunicationReplyCloudJob;
  logContext: string;
}): Promise<string | null> {
  try {
    return await buildCommunicationThreadReplyFooterText(params);
  } catch (error) {
    console.error(
      `[${params.logContext}] Failed to build ${params.providerLabel} reply footer for cloud job ${params.cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function getCommunicationReplyImages(params: {
  cloudJob: Pick<CommunicationReplyCloudJob, 'id' | 'taskId'>;
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
        cloudJob: params.cloudJob,
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
  cloudJobId: number;
  logContext: string;
  postReplyWithFooter: () => Promise<PostedFooterRecord<TReply>>;
  clearPreviousFooter: (
    previousFooterRecord: ThreadReplyFooterRecord,
  ) => Promise<void>;
}): Promise<TReply> {
  return withThreadReplyFooterLock({
    lockKey: params.lockKey,
    fn: async () => {
      let previousFooterRecord: ThreadReplyFooterRecord | null = null;
      try {
        previousFooterRecord = await getThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
        );
      } catch (error) {
        console.error(
          `[${params.logContext}] Failed to read previous ${params.providerLabel} footer record for cloud job ${params.cloudJobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const posted = await params.postReplyWithFooter();

      if (
        previousFooterRecord &&
        previousFooterRecord.messageId !== posted.messageId
      ) {
        try {
          await params.clearPreviousFooter(previousFooterRecord);
        } catch (error) {
          console.error(
            `[${params.logContext}] Failed to clear prior ${params.providerLabel} footer message ${previousFooterRecord.messageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      try {
        await setThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
          {
            messageId: posted.messageId,
            textWithoutFooter: posted.textWithoutFooter,
          },
        );
      } catch (error) {
        console.error(
          `[${params.logContext}] Failed to persist latest ${params.providerLabel} footer record ${posted.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return posted;
    },
  });
}
