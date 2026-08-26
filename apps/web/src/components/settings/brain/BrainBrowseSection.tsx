'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BRAIN_NAMESPACES } from '@roomote/types';

import { Section } from '@/components/settings';
import {
  Badge,
  BasicTooltip,
  BookOpenText,
  Button,
  EmptyState,
  Input,
  Search,
  Skeleton,
} from '@/components/system';
import { cn } from '@/lib/utils';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import type {
  BrainCorpusSummary,
  BrainPageListing,
} from '@/trpc/commands/brain';
import { brainNamespaceColor } from './brain-presentation';

type ListedPage = BrainPageListing['pages'][number];

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 200;

/** Registry position, so the filter chips keep a stable, meaningful order. */
function namespaceRank(id: string): number {
  const index = BRAIN_NAMESPACES.findIndex((namespace) => namespace.id === id);

  return index === -1 ? BRAIN_NAMESPACES.length : index;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);

    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
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
      aria-current={selected ? 'page' : undefined}
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
        description="Memory did not answer for this page. It may have been removed, or Memory may be briefly unreachable."
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

export function BrainBrowseSection({
  corpus,
  namespaceId,
  selectedSlug,
  onSelectNamespace,
  onSelectMemory,
}: {
  corpus: BrainCorpusSummary;
  namespaceId: string | null;
  selectedSlug: string | null;
  onSelectNamespace: (namespaceId: string | null) => void;
  onSelectMemory: (slug: string | null) => void;
}) {
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);

  const { data, isPending } = useQuery(
    trpc.brain.listPages.queryOptions(
      {
        search: debouncedSearch || undefined,
        namespaceId: namespaceId ?? undefined,
        offset,
        limit: PAGE_SIZE,
      },
      { placeholderData: keepPreviousData },
    ),
  );
  const pages = data?.pages ?? [];

  const namespaces = useMemo(
    () =>
      [...corpus.namespaces].sort(
        (left, right) => namespaceRank(left.id) - namespaceRank(right.id),
      ),
    [corpus.namespaces],
  );

  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch]);

  const selectNamespace = useCallback(
    (nextNamespaceId: string | null) => {
      onSelectNamespace(nextNamespaceId);
      setOffset(0);
    },
    [onSelectNamespace],
  );

  const pageList = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scroll-thin pr-1">
        {pages.map((page) => (
          <PageListRow
            key={page.slug}
            page={page}
            selected={page.slug === selectedSlug}
            onSelect={onSelectMemory}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        <p className="pl-3 text-xs text-muted-foreground">
          {data && data.total > 0
            ? `${formatNumber(offset + 1)}-${formatNumber(offset + pages.length)} of ${formatNumber(data.total)}`
            : '0 pages'}
        </p>
        <div className="flex gap-1">
          <BasicTooltip content="Previous page">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous page"
              disabled={offset === 0}
              onClick={() =>
                setOffset((current) => Math.max(0, current - PAGE_SIZE))
              }
            >
              ←
            </Button>
          </BasicTooltip>
          <BasicTooltip content="Next page">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next page"
              disabled={data?.nextOffset === null}
              onClick={() =>
                data?.nextOffset !== null && setOffset(data?.nextOffset ?? 0)
              }
            >
              →
            </Button>
          </BasicTooltip>
        </div>
      </div>
    </div>
  );

  return (
    <Section icon={BookOpenText} title="Explore memories">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          What Memory has stored, page by page.
        </p>
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
            onChange={(event) => {
              setSearch(event.target.value);
              if (selectedSlug) {
                onSelectMemory(null);
              }
            }}
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
              onClick={() => selectNamespace(null)}
            >
              All
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
                  selectNamespace(
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
                {namespace.label}
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
            description="Memory did not answer, so its pages cannot be listed right now."
          />
        ) : data?.pages.length === 0 ? (
          <EmptyState
            title="No matching pages"
            description="Nothing in Memory matches this search."
          />
        ) : selectedSlug ? (
          <div className="grid h-[500px] grid-cols-1 grid-rows-2 divide-y md:grid-cols-[280px_1fr] md:grid-rows-1 md:divide-x md:divide-y-0">
            {/* The list and preview stack below `md`, then sit side by side. */}
            {pageList}
            <div className="min-h-0">
              <PagePreview slug={selectedSlug} />
            </div>
          </div>
        ) : (
          <div className="flex h-[500px] min-h-0">{pageList}</div>
        )}
      </div>
    </Section>
  );
}
