import type { BrainCorpusSnapshot } from '@roomote/sdk/server';
import {
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  type BrainNamespaceBucketId,
} from '@roomote/types';

export type BrainPageListing = {
  reachable: boolean;
  total: number;
  nextOffset: number | null;
  pages: Array<{
    slug: string;
    title: string;
    namespaceId: BrainNamespaceBucketId;
    namespaceLabel: string;
    updatedAt: Date | null;
  }>;
};

function toListedPage(page: {
  slug: string;
  title: string | null;
  updatedAt: Date | null;
}): BrainPageListing['pages'][number] {
  const namespaceId = resolveBrainNamespaceId(page.slug);

  return {
    slug: page.slug,
    title: page.title ?? page.slug,
    namespaceId,
    namespaceLabel: brainNamespaceLabel(namespaceId),
    updatedAt: page.updatedAt,
  };
}

/** Exported for focused command tests; the command below owns auth and I/O. */
export function paginateBrainCorpus(
  snapshot: BrainCorpusSnapshot,
  input: {
    search?: string;
    namespaceId?: string;
    offset: number;
    limit: number;
  },
): Omit<BrainPageListing, 'reachable'> {
  const needle = input.search?.trim().toLowerCase() ?? '';
  const filtered = snapshot.pages.filter((page) => {
    const namespaceId = resolveBrainNamespaceId(page.slug);

    return (
      (!input.namespaceId || namespaceId === input.namespaceId) &&
      (!needle ||
        page.slug.toLowerCase().includes(needle) ||
        page.title?.toLowerCase().includes(needle))
    );
  });
  const pages = filtered
    .slice(input.offset, input.offset + input.limit)
    .map(toListedPage);

  return {
    total: filtered.length,
    nextOffset:
      input.offset + pages.length < filtered.length
        ? input.offset + pages.length
        : null,
    pages,
  };
}
