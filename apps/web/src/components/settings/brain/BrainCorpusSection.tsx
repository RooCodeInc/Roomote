'use client';

import { Section } from '@/components/settings';
import {
  Badge,
  BasicTooltip,
  Database,
  EmptyState,
  TriangleAlert,
} from '@/components/system';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';

import type { BrainCorpusSummary } from '@/trpc/commands/brain';
import { buildNamespaceSegments } from './brain-presentation';

/**
 * A segment thinner than this is unreadable and unhoverable, so the bar stops
 * shrinking there. The legend carries the exact numbers, and a bar that reads
 * "present but tiny" is more honest than a sliver that reads as absent.
 */
const MIN_SEGMENT_PERCENT = 1.5;

function CompositionBar({
  segments,
}: {
  segments: ReturnType<typeof buildNamespaceSegments>;
}) {
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-background">
      {segments.map((segment) => (
        <BasicTooltip
          key={segment.id}
          content={`${segment.label}: ${formatNumber(segment.pages)} pages (${Math.round(segment.percent)}%)`}
        >
          <div
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${Math.max(segment.percent, MIN_SEGMENT_PERCENT)}%`,
              backgroundColor: segment.color,
            }}
          />
        </BasicTooltip>
      ))}
    </div>
  );
}

export function BrainCorpusSection({ corpus }: { corpus: BrainCorpusSummary }) {
  const segments = buildNamespaceSegments(corpus.namespaces);

  return (
    <Section
      icon={Database}
      title="What the Brain knows"
      action={
        corpus.reachable && corpus.sampledPages > 0 ? (
          <span className="text-sm text-muted-foreground">
            {corpus.truncated
              ? `${formatNumber(corpus.sampledPages)} most recent pages`
              : `${formatNumber(corpus.sampledPages)} pages`}
          </span>
        ) : null
      }
    >
      {!corpus.reachable ? (
        <EmptyState
          icon={<TriangleAlert className="size-6 text-warning" />}
          title="Corpus unavailable"
          description="The Brain did not answer, so its contents cannot be shown. Collectors keep their position while it is down."
        />
      ) : segments.length === 0 ? (
        <EmptyState
          title="Nothing collected yet"
          description="Pages appear here as tasks complete and connected integrations are read."
        />
      ) : (
        <div className="space-y-4">
          <CompositionBar segments={segments} />

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {segments.map((segment) => (
              <div key={segment.id} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="truncate">{segment.label}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {formatNumber(segment.pages)}
                </span>
              </div>
            ))}
          </div>

          {corpus.truncated ? (
            <p className="text-xs text-muted-foreground">
              The Brain lists its most recent pages, so this describes what it
              has learned lately rather than everything it holds.
            </p>
          ) : null}

          {corpus.recentPages.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm font-medium">Recently learned</p>
              <ul className="space-y-2">
                {corpus.recentPages.map((page) => (
                  <li
                    key={page.slug}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="truncate">{page.title}</span>
                    <Badge variant="outline">{page.namespaceLabel}</Badge>
                    {page.updatedAt ? (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNowCompact(page.updatedAt, {
                          addSuffix: true,
                        })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}
