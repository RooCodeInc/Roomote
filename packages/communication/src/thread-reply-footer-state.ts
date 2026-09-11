import { getRedis } from '@roomote/redis';
import type { CommunicationProvider } from '@roomote/types';
import { scheduleThreadFooterRefresh } from './thread-footer-refresh';
import type { CommunicationMessageButton } from './provider';

const THREAD_REPLY_FOOTER_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ThreadReplyFooterLock = { key: string; ownerId: string };

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
  buttons?: CommunicationMessageButton[][];
  refresh?: {
    footerText: string;
    /** Discord thread channels differ from the pointer's parent channel. */
    channelId: string;
    serviceUrl?: string;
  };
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
        ...(Array.isArray(parsed.buttons) ? { buttons: parsed.buttons } : {}),
        ...(parsed.refresh &&
        typeof parsed.refresh.footerText === 'string' &&
        typeof parsed.refresh.channelId === 'string'
          ? { refresh: parsed.refresh }
          : {}),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns false when the supplied lease no longer owns the lock, or when a
 * `keepTtl` write found no record to update (it expired since it was read).
 */
export async function setThreadReplyFooterRecord(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
  record: ThreadReplyFooterRecord,
  options?: { keepTtl?: boolean; lock?: ThreadReplyFooterLock },
): Promise<boolean> {
  const redis = getRedis();
  if (options?.lock) {
    const written = await redis.eval(
      `if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
       if ARGV[3] == 'keepTtl' then
         -- A record that expired since it was read cannot be revived: report it.
         if not redis.call('set', KEYS[2], ARGV[2], 'KEEPTTL', 'XX') then return 0 end
       else
         redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
       end
       return 1`,
      2,
      options.lock.key,
      getThreadReplyFooterKey(provider, channelId, threadId),
      options.lock.ownerId,
      JSON.stringify(record),
      options.keepTtl ? 'keepTtl' : THREAD_REPLY_FOOTER_TTL_SECONDS,
    );
    if (!written) return false;
    if (options.keepTtl) return true;
  } else if (options?.keepTtl) {
    const written = await redis.set(
      getThreadReplyFooterKey(provider, channelId, threadId),
      JSON.stringify(record),
      'KEEPTTL',
      'XX',
    );
    return written === 'OK';
  } else {
    await redis.set(
      getThreadReplyFooterKey(provider, channelId, threadId),
      JSON.stringify(record),
      'EX',
      THREAD_REPLY_FOOTER_TTL_SECONDS,
    );
  }
  if (record.refresh)
    await scheduleThreadFooterRefresh({ provider, channelId, threadId }).catch(
      (error) => {
        console.warn('[threadFooter] Failed to schedule footer refresh', error);
      },
    );
  return true;
}
