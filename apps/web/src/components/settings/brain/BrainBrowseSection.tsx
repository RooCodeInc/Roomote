'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
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
type PageEdge = 'first' | 'last';

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
      data-memory-slug={page.slug}
      onClick={() => onSelect(page.slug)}
      className={cn(
        'w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <p className="truncate text-sm font-medium">{page.title}</p>
      {page.updatedAt ? (
        <p className="truncate text-xs text-muted-foreground">
          updated{' '}
          {formatDistanceToNowCompact(page.updatedAt, { addSuffix: true })}
        </p>
      ) : null}
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
      <div className="space-y-2 px-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        title="Memory unavailable"
        description="Memory did not answer for this memory. It may have been removed, or Memory may be briefly unreachable."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{data.title}</p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {data.updatedAt ? (
            <>
              <span>
                updated{' '}
                {formatDistanceToNowCompact(data.updatedAt, {
                  addSuffix: true,
                })}
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span className="font-mono text-[0.9em]">{data.slug}</span>
        </div>
      </div>
      {/*
       * Brain memories are distilled from tasks and integrations: cross-user
       * content, rendered strictly as text.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin rounded-lg bg-background/60 p-3">
        <pre className="font-mono text-xs whitespace-pre-wrap">
          {data.content ?? 'This memory has no stored content.'}
        </pre>
        {data.contentTruncated ? (
          <p className="pt-2 text-xs text-muted-foreground">
            Long memory, preview cut. Agents still read the full memory.
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
  const [pendingPageSelection, setPendingPageSelection] = useState<{
    edge: PageEdge;
    offset: number;
  } | null>(null);
  const [keyboardTargetSlug, setKeyboardTargetSlug] = useState<string | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);

  const { data, isFetching, isPending } = useQuery(
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

  useEffect(() => {
    if (
      !pendingPageSelection ||
      isFetching ||
      offset !== pendingPageSelection.offset
    ) {
      return;
    }

    const memory =
      pendingPageSelection.edge === 'first' ? pages[0] : pages.at(-1);

    if (memory) {
      setKeyboardTargetSlug(memory.slug);
      onSelectMemory(memory.slug);
    }
    setPendingPageSelection(null);
  }, [isFetching, offset, onSelectMemory, pages, pendingPageSelection]);

  useEffect(() => {
    if (!keyboardTargetSlug || keyboardTargetSlug !== selectedSlug) {
      return;
    }

    const selectedRow = [
      ...(listRef.current?.querySelectorAll('button') ?? []),
    ].find((row) => row.dataset.memorySlug === keyboardTargetSlug);

    selectedRow?.focus();
    setKeyboardTargetSlug(null);
  }, [keyboardTargetSlug, pages, selectedSlug]);

  const selectNamespace = useCallback(
    (nextNamespaceId: string | null) => {
      onSelectNamespace(nextNamespaceId);
      setOffset(0);
    },
    [onSelectNamespace],
  );

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        return;
      }

      const currentIndex = pages.findIndex(
        (memory) => memory.slug === selectedSlug,
      );
      if (currentIndex === -1) {
        return;
      }

      event.preventDefault();
      const nextIndex = currentIndex + (event.key === 'ArrowDown' ? 1 : -1);
      const nextOffset = data?.nextOffset;

      if (nextIndex >= 0 && nextIndex < pages.length) {
        const memory = pages[nextIndex]!;
        setKeyboardTargetSlug(memory.slug);
        onSelectMemory(memory.slug);
        return;
      }

      if (event.key === 'ArrowDown' && nextOffset != null) {
        setPendingPageSelection({ edge: 'first', offset: nextOffset });
        setOffset(nextOffset);
      } else if (event.key === 'ArrowUp' && offset > 0) {
        const previousOffset = Math.max(0, offset - PAGE_SIZE);
        setPendingPageSelection({ edge: 'last', offset: previousOffset });
        setOffset(previousOffset);
      }
    },
    [data?.nextOffset, offset, onSelectMemory, pages, selectedSlug],
  );

  const pageList = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        onKeyDown={handleListKeyDown}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scroll-thin pr-1"
      >
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
            : '0 memories'}
        </p>
        <div className="flex gap-1">
          <BasicTooltip content="Previous memories">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous memories"
              disabled={offset === 0}
              onClick={() =>
                setOffset((current) => Math.max(0, current - PAGE_SIZE))
              }
            >
              ←
            </Button>
          </BasicTooltip>
          <BasicTooltip content="Next memories">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next memories"
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
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search memories"
            className="pl-9"
            placeholder="Search memories"
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
            description="Memory did not answer, so its memories cannot be listed right now."
          />
        ) : data?.pages.length === 0 ? (
          <EmptyState
            title="No matching memories"
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
