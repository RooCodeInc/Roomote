'use client';

import { Section } from '@/components/settings';
import {
  BasicTooltip,
  ChartColumn,
  EmptyState,
  TriangleAlert,
} from '@/components/system';
import { formatNumber, formatShortDate } from '@/lib/formatters';

import type { BrainCorpusSummary } from '@/trpc/commands/brain';
import { buildNamespaceSegments } from './brain-presentation';

function formatActivityDate(date: string): string {
  return formatShortDate(new Date(`${date}T00:00:00`));
}

function ActivityChart({
  days,
}: {
  days: BrainCorpusSummary['activityByDay'];
}) {
  const max = Math.max(...days.map((day) => day.pages), 1);
  const total = days.reduce((sum, day) => sum + day.pages, 0);

  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No memories written in the last 30 days.
      </p>
    );
  }

  return (
    <div role="img" aria-label="Memory activity chart" className="space-y-1">
      <div className="flex h-20 items-end gap-[3px] border-b border-foreground/10">
        {days.map((day) => (
          <BasicTooltip
            key={day.date}
            content={`${formatActivityDate(day.date)}: ${formatNumber(day.pages)} memories`}
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
  onSelectNamespace,
}: {
  segments: ReturnType<typeof buildNamespaceSegments>;
  onSelectNamespace: (namespaceId: string) => void;
}) {
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-background">
      {segments.map((segment) => (
        <BasicTooltip
          key={segment.id}
          content={`${segment.label}: ${formatNumber(segment.pages)} memories (${Math.round(segment.percent)}%)`}
        >
          <button
            type="button"
            aria-label={`Filter Explore memories by ${segment.label}`}
            className="h-full cursor-pointer first:rounded-l-full last:rounded-r-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => onSelectNamespace(segment.id)}
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

export function BrainCorpusSection({
  corpus,
  onSelectNamespace,
}: {
  corpus: BrainCorpusSummary;
  onSelectNamespace: (namespaceId: string) => void;
}) {
  const segments = buildNamespaceSegments(corpus.namespaces);

  return (
    <Section
      icon={ChartColumn}
      title="Memory Stats"
      action={
        corpus.reachable && corpus.listedPages > 0 ? (
          <span className="text-sm font-normal text-muted-foreground">
            {formatNumber(corpus.listedPages)} memories
          </span>
        ) : null
      }
    >
      {!corpus.reachable ? (
        <EmptyState
          icon={<TriangleAlert className="size-6 text-warning" />}
          title="Corpus unavailable"
          description="Memory did not answer, so its contents cannot be shown. Collectors keep their position while it is down."
        />
      ) : segments.length === 0 ? (
        <EmptyState
          title="Nothing collected yet"
          description="Memories appear here as tasks complete and connected integrations are read."
        />
      ) : (
        <div className="space-y-4">
          <CompositionBar
            segments={segments}
            onSelectNamespace={onSelectNamespace}
          />

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {segments.map((segment) => (
              <button
                key={segment.id}
                type="button"
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectNamespace(segment.id)}
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="truncate">{segment.label}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {formatNumber(segment.pages)}
                </span>
              </button>
            ))}
          </div>

          {corpus.activityByDay.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">
                  Memory activity (past 30 days)
                </p>
                <span className="text-xs text-muted-foreground">
                  {formatNumber(
                    corpus.activityByDay.reduce(
                      (sum, day) => sum + day.pages,
                      0,
                    ),
                  )}{' '}
                  memories
                </span>
              </div>
              <ActivityChart days={corpus.activityByDay} />
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}
