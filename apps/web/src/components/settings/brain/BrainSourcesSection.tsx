'use client';

import { Section } from '@/components/settings';
import { Badge, Progress, RadioTower } from '@/components/system';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';

import type { BrainSourceSummary } from '@/trpc/commands/brain';
import { describeSourceStatus } from './brain-presentation';

function SourceRow({ source }: { source: BrainSourceSummary }) {
  const status = describeSourceStatus(source.status);
  const backfillPercent =
    source.partitions === 0
      ? null
      : (source.partitionsBackfilled / source.partitions) * 100;

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="font-medium">{source.label}</span>
        <Badge variant="outline">{source.namespaceLabel}</Badge>
        <Badge variant={status.variant} className="ml-auto">
          {status.label}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">{source.description}</p>

      {status.hint ? (
        <p className="text-xs text-muted-foreground">{status.hint}</p>
      ) : null}

      {source.status !== 'not_connected' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {source.lastSyncedAt
              ? `Last read ${formatDistanceToNowCompact(source.lastSyncedAt, {
                  addSuffix: true,
                })}`
              : 'Not read yet'}
          </span>
          {source.trackedItems > 0 ? (
            <span>{formatNumber(source.trackedItems)} tracked</span>
          ) : null}
          {source.partitions > 1 ? (
            <span>{formatNumber(source.partitions)} streams</span>
          ) : null}
        </div>
      ) : null}

      {backfillPercent !== null && source.status === 'backfilling' ? (
        <div className="space-y-1">
          <Progress value={backfillPercent} />
          <p className="text-xs text-muted-foreground">
            History read for {source.partitionsBackfilled} of{' '}
            {source.partitions} streams.
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function BrainSourcesSection({
  sources,
}: {
  sources: BrainSourceSummary[];
}) {
  const connected = sources.filter(
    (source) => source.status !== 'not_connected',
  ).length;

  return (
    <Section
      icon={RadioTower}
      title="Where it learns from"
      action={
        <span className="text-sm text-muted-foreground">
          {connected} of {sources.length} connected
        </span>
      }
    >
      <ul className="divide-y">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} />
        ))}
      </ul>
    </Section>
  );
}
