import { readBrainPage } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * How much of a page body the preview ships. A Brain page can be an entire
 * day of channel history; the dialog is a reading pane, not an export.
 */
const PAGE_CONTENT_PREVIEW_LIMIT = 32_000;

type BrainPageContent = {
  slug: string;
  title: string;
  updatedAt: Date | null;
  /**
   * The page body as the Brain stores it. Untrusted content distilled from
   * tasks and integrations: the client renders it as plain text.
   */
  content: string | null;
  /** The body exceeded the preview bound and was cut. */
  contentTruncated: boolean;
};

export async function getBrainPageCommand(
  auth: UserAuthSuccess,
  input: { slug: string },
): Promise<BrainPageContent | null> {
  assertAdmin(auth);

  const page = await readBrainPage(input.slug);

  if (!page) {
    return null;
  }

  const contentTruncated =
    (page.content?.length ?? 0) > PAGE_CONTENT_PREVIEW_LIMIT;

  return {
    slug: page.slug,
    title: page.title ?? page.slug,
    updatedAt: page.updatedAt,
    content: contentTruncated
      ? page.content!.slice(0, PAGE_CONTENT_PREVIEW_LIMIT)
      : page.content,
    contentTruncated,
  };
}
