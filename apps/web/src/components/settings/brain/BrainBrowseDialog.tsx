'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BRAIN_NAMESPACES } from '@roomote/types';

import {
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Search,
  Skeleton,
} from '@/components/system';
import { cn } from '@/lib/utils';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import type { BrainPageListing } from '@/trpc/commands/brain';
import { brainNamespaceColor } from './brain-presentation';

type ListedPage = BrainPageListing['pages'][number];

/**
 * Rows rendered at once. The sample caps at 500 pages and every keystroke
 * re-filters, so an unbounded list re-renders hundreds of rows to show the
 * eight that fit the viewport; past this bound the footer says to narrow the
 * search instead.
 */
const RENDERED_PAGE_LIMIT = 150;

/** Registry position, so the filter chips keep a stable, meaningful order. */
function namespaceRank(id: string): number {
  const index = BRAIN_NAMESPACES.findIndex((namespace) => namespace.id === id);

  return index === -1 ? BRAIN_NAMESPACES.length : index;
}

function matchesSearch(page: ListedPage, needle: string): boolean {
  return (
    page.slug.toLowerCase().includes(needle) ||
    page.title.toLowerCase().includes(needle)
  );
}

const PageListRow = memo(function PageListRow({
  page,
  selected,
  onSelect,
}: {
  page: ListedPage;
  selected: boolean;
  onSelect: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(page.slug)}
      className={cn(
        'w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <p className="truncate text-sm font-medium">{page.title}</p>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {page.slug}
      </p>
    </button>
  );
});

function PagePreview({ slug }: { slug: string }) {
  const trpc = useTRPC();
  const { data, isPending } = useQuery(
    trpc.brain.getPage.queryOptions({ slug }),
  );

  if (isPending) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        title="Page unavailable"
        description="The Brain did not answer for this page. It may have been removed, or the Brain may be briefly unreachable."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{data.title}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{data.slug}</span>
          {data.updatedAt ? (
            <span>
              updated{' '}
              {formatDistanceToNowCompact(data.updatedAt, { addSuffix: true })}
            </span>
          ) : null}
        </div>
      </div>
      {/*
       * Brain pages are distilled from tasks and integrations: cross-user
       * content, rendered strictly as text.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin rounded-lg bg-background/60 p-3">
        <pre className="font-mono text-xs whitespace-pre-wrap">
          {data.content ?? 'This page has no stored content.'}
        </pre>
        {data.contentTruncated ? (
          <p className="pt-2 text-xs text-muted-foreground">
            Long page, preview cut. Agents still read the full page.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function BrainBrowseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const [namespaceId, setNamespaceId] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const { data, isPending } = useQuery(
    trpc.brain.listPages.queryOptions(undefined, { enabled: open }),
  );
  const pages = data?.pages ?? [];

  const namespaces = useMemo(() => {
    const counts = new Map<string, { label: string; pages: number }>();

    for (const page of data?.pages ?? []) {
      const existing = counts.get(page.namespaceId);

      if (existing) {
        existing.pages += 1;
      } else {
        counts.set(page.namespaceId, { label: page.namespaceLabel, pages: 1 });
      }
    }

    return [...counts.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((left, right) => namespaceRank(left.id) - namespaceRank(right.id));
  }, [data?.pages]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return (data?.pages ?? []).filter(
      (page) =>
        (namespaceId === null || page.namespaceId === namespaceId) &&
        (needle === '' || matchesSearch(page, needle)),
    );
  }, [data?.pages, namespaceId, search]);

  // Explicit clicks only: auto-selecting the head of the filtered list would
  // issue a page read per keystroke as the first match changes.
  const selected =
    selectedSlug !== null && filtered.some((page) => page.slug === selectedSlug)
      ? selectedSlug
      : null;

  const handleSelect = useCallback((slug: string) => setSelectedSlug(slug), []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="4xl">
        <DialogHeader>
          <DialogTitle>Browse memory</DialogTitle>
          <DialogDescription>
            What the Brain has stored, page by page.
            {data?.truncated
              ? ' The Brain lists its most recent pages, so older ones are not shown here.'
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search pages"
              className="pl-9"
              placeholder="Search pages"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              asChild
              variant={namespaceId === null ? 'default' : 'secondary'}
            >
              <button
                type="button"
                className="cursor-pointer"
                onClick={() => setNamespaceId(null)}
              >
                All {formatNumber(pages.length)}
              </button>
            </Badge>
            {namespaces.map((namespace) => (
              <Badge
                key={namespace.id}
                asChild
                variant={namespaceId === namespace.id ? 'default' : 'secondary'}
              >
                <button
                  type="button"
                  className="cursor-pointer"
                  onClick={() =>
                    setNamespaceId(
                      namespaceId === namespace.id ? null : namespace.id,
                    )
                  }
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: brainNamespaceColor(namespace.id),
                    }}
                  />
                  {namespace.label} {formatNumber(namespace.pages)}
                </button>
              </Badge>
            ))}
          </div>

          {isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : !data?.reachable ? (
            <EmptyState
              title="Corpus unavailable"
              description="The Brain did not answer, so its pages cannot be listed right now."
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No matching pages"
              description="Nothing in the Brain matches this search."
            />
          ) : (
            <div className="grid h-[420px] grid-cols-1 gap-3 sm:grid-cols-[280px_1fr]">
              <div className="flex min-h-0 flex-col">
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scroll-thin pr-1">
                  {filtered.slice(0, RENDERED_PAGE_LIMIT).map((page) => (
                    <PageListRow
                      key={page.slug}
                      page={page}
                      selected={page.slug === selected}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
                <p className="pt-2 text-xs text-muted-foreground">
                  {filtered.length > RENDERED_PAGE_LIMIT
                    ? `Showing ${formatNumber(RENDERED_PAGE_LIMIT)} of ${formatNumber(filtered.length)} pages, newest first. Search to narrow further.`
                    : `${formatNumber(filtered.length)} pages, newest first`}
                </p>
              </div>
              <div className="hidden min-h-0 rounded-lg border sm:block">
                {selected ? (
                  <PagePreview slug={selected} />
                ) : (
                  <EmptyState
                    title="Select a page"
                    description="Choose a page to read what the Brain stored."
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
