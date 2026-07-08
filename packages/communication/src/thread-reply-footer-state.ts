import { getRedis } from '@roomote/redis';
import type { CommunicationProvider } from '@roomote/types';

const THREAD_REPLY_FOOTER_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ThreadReplyFooterImage = {
  url: string;
  altText: string;
  contentType?: string;
};

export type ThreadReplyFooterRecord = {
  /** Provider message id of the latest footer-bearing reply in the thread. */
  messageId: string;
  /**
   * The reply text without the footer, used to rewrite the previous message
   * when the footer is relocated to a newer reply.
   */
  textWithoutFooter: string;
  /**
   * Images originally attached to the footer-bearing reply. Required when
   * clearing the footer via text-only providers like Teams Bot Framework so
   * re-edits do not drop attachment content.
   */
  images?: ThreadReplyFooterImage[];
};

function parseThreadReplyFooterImages(
  value: unknown,
): ThreadReplyFooterImage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const images: ThreadReplyFooterImage[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }

    const url = (entry as { url?: unknown }).url;
    const altText = (entry as { altText?: unknown }).altText;
    const contentType = (entry as { contentType?: unknown }).contentType;

    if (typeof url !== 'string' || url.length === 0) {
      return undefined;
    }

    if (typeof altText !== 'string') {
      return undefined;
    }

    if (
      contentType !== undefined &&
      (typeof contentType !== 'string' || contentType.length === 0)
    ) {
      return undefined;
    }

    images.push({
      url,
      altText,
      ...(contentType ? { contentType } : {}),
    });
  }

  return images;
}

function getThreadReplyFooterKey(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
): string {
  return `${provider}:thread_reply_footer:${channelId}:${threadId}`;
}

export async function getThreadReplyFooterRecord(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
): Promise<ThreadReplyFooterRecord | null> {
  const redis = getRedis();
  const rawRecord = await redis.get(
    getThreadReplyFooterKey(provider, channelId, threadId),
  );

  if (!rawRecord) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawRecord) as Partial<ThreadReplyFooterRecord>;

    if (
      typeof parsed.messageId === 'string' &&
      parsed.messageId.length > 0 &&
      typeof parsed.textWithoutFooter === 'string'
    ) {
      const images = parseThreadReplyFooterImages(parsed.images);

      // Malformed image payload: keep text/name only rather than rejecting the
      // whole footer record, so footer relocation for text still works.
      return {
        messageId: parsed.messageId,
        textWithoutFooter: parsed.textWithoutFooter,
        ...(images ? { images } : {}),
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function setThreadReplyFooterRecord(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
  record: ThreadReplyFooterRecord,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    getThreadReplyFooterKey(provider, channelId, threadId),
    JSON.stringify(record),
    'EX',
    THREAD_REPLY_FOOTER_TTL_SECONDS,
  );
}
