'use client';

import { useState } from 'react';

import { Section } from '@/components/settings';
import {
  Badge,
  BasicTooltip,
  Button,
  Database,
  EmptyState,
  TriangleAlert,
} from '@/components/system';
import {
  formatDistanceToNowCompact,
  formatNumber,
  formatShortDate,
} from '@/lib/formatters';

import type { BrainCorpusSummary } from '@/trpc/commands/brain';
import { BrainBrowseDialog } from './BrainBrowseDialog';
import { buildNamespaceSegments } from './brain-presentation';

function formatActivityDate(date: string): string {
  return formatShortDate(new Date(`${date}T00:00:00`));
}

function ActivityChart({
  days,
  sampleTruncated,
}: {
  days: BrainCorpusSummary['activityByDay'];
  sampleTruncated: boolean;
}) {
  const max = Math.max(...days.map((day) => day.pages), 1);
  const total = days.reduce((sum, day) => sum + day.pages, 0);

  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No pages written in the last 30 days.
      </p>
    );
  }

  // A freshly enabled Brain has all of its activity in the last day or two,
  // which renders as one tower over 29 empty days and reads as a broken
  // chart rather than a young corpus. Say what is actually happening.
  const firstActiveIndex = days.findIndex((day) => day.pages > 0);

  if (firstActiveIndex >= days.length - 2) {
    // On a truncated sample this shape means the recency window is shallow
    // (a burst of writes), not that the Brain is new: a corpus holding
    // months of history looks exactly like this after a replay. Only an
    // untruncated sample proves the corpus itself is young.
    if (sampleTruncated) {
      return (
        <p className="text-xs text-muted-foreground">
          The {formatNumber(total)} most recent pages were all written in the
          last two days, which is as far back as this sample reaches.
        </p>
      );
    }

    return (
      <p className="text-xs text-muted-foreground">
        Ingestion started{' '}
        {firstActiveIndex === days.length - 1 ? 'today' : 'yesterday'}.{' '}
        {formatNumber(total)} pages written so far; the chart appears as history
        accumulates.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex h-20 items-end gap-[3px] border-b border-foreground/10">
        {days.map((day) => (
          <BasicTooltip
            key={day.date}
            content={`${formatActivityDate(day.date)}: ${formatNumber(day.pages)} pages`}
          >
            <div
              className="min-h-px flex-1 rounded-t-[2px]"
              style={{
                height: `${(day.pages / max) * 100}%`,
                backgroundColor:
                  day.pages > 0 ? 'var(--color-chart-4)' : 'transparent',
              }}
            />
          </BasicTooltip>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatActivityDate(days[0]!.date)}</span>
        <span>{formatActivityDate(days[days.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

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
  const [browseOpen, setBrowseOpen] = useState(false);

  return (
    <Section
      icon={Database}
      title="What the Brain knows"
      action={
        corpus.reachable && corpus.sampledPages > 0 ? (
          <span className="flex items-center gap-3">
            <span className="text-sm font-normal text-muted-foreground">
              {corpus.truncated
                ? `${formatNumber(corpus.sampledPages)} most recent pages`
                : `${formatNumber(corpus.sampledPages)} pages`}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBrowseOpen(true)}
            >
              Browse memory
            </Button>
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

          {corpus.activityByDay.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">
                  Pages written, last 30 days
                </p>
                <span className="text-xs text-muted-foreground">
                  {formatNumber(
                    corpus.activityByDay.reduce(
                      (sum, day) => sum + day.pages,
                      0,
                    ),
                  )}{' '}
                  pages
                </span>
              </div>
              <ActivityChart
                days={corpus.activityByDay}
                sampleTruncated={corpus.truncated}
              />
            </div>
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

      <BrainBrowseDialog open={browseOpen} onOpenChange={setBrowseOpen} />
    </Section>
  );
}
