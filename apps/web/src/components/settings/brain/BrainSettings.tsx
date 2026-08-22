'use client';

import { useQuery } from '@tanstack/react-query';

import {
  AnalyticsSummaryCard,
  AnalyticsSummaryCardsGrid,
  AnalyticsSummaryCardSkeleton,
  ErrorState,
  Skeleton,
} from '@/components/system';
import { formatDistanceToNowCompact, formatNumber } from '@/lib/formatters';
import { useTRPC } from '@/trpc/client';

import type { BrainSettings as BrainSettingsData } from '@/trpc/commands/brain';
import { BrainConfigurationSection } from './BrainConfigurationSection';
import { BrainCorpusSection } from './BrainCorpusSection';
import { BrainSourcesSection } from './BrainSourcesSection';
import { BrainStatusSection } from './BrainStatusSection';
import { BrainTaskMemorySection } from './BrainTaskMemorySection';

function SummaryTiles({ settings }: { settings: BrainSettingsData }) {
  const recorded = settings.taskMemories.byStatus.done;

  return (
    <AnalyticsSummaryCardsGrid className="md:grid-cols-2">
      <AnalyticsSummaryCard
        label="Pages stored"
        value={
          settings.corpus.totalPages !== null
            ? formatNumber(settings.corpus.totalPages)
            : settings.corpus.reachable
              ? formatNumber(settings.corpus.listedPages)
              : 'Unknown'
        }
        secondary={
          settings.corpus.totalPages !== null
            ? 'in the corpus'
            : 'in the corpus'
        }
      />
      <AnalyticsSummaryCard
        label="Task memories"
        value={formatNumber(recorded)}
        secondary={
          settings.taskMemories.lastProcessedAt
            ? `last recorded ${formatDistanceToNowCompact(
                settings.taskMemories.lastProcessedAt,
                { addSuffix: true },
              )}`
            : 'none recorded yet'
        }
      />
    </AnalyticsSummaryCardsGrid>
  );
}

function BrainSettingsSkeleton() {
  return (
    <div className="space-y-6">
      <AnalyticsSummaryCardsGrid className="md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <AnalyticsSummaryCardSkeleton key={index} />
        ))}
      </AnalyticsSummaryCardsGrid>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-80 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function BrainSettings() {
  const trpc = useTRPC();
  const { data, isPending, isError } = useQuery(trpc.brain.get.queryOptions());

  if (isPending) {
    return <BrainSettingsSkeleton />;
  }

  if (isError) {
    return <ErrorState title="Failed to load the Brain" />;
  }

  /*
   * A deployment without a Brain has no corpus, no collector checkpoints,
   * and no outbox worth reading: those sections would all render the same
   * empty state, which reads as breakage rather than as an unconfigured
   * feature. The same goes for a key with no service URL, where offering
   * actions like the history backfill would enqueue work nothing can drain
   * into.
   */
  if (data.status === 'not_configured' || !data.url) {
    return (
      <div className="space-y-6">
        <BrainStatusSection settings={data} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SummaryTiles settings={data} />
      <BrainStatusSection settings={data} />
      <BrainConfigurationSection settings={data} />
      <BrainSourcesSection sources={data.sources} />
      <BrainCorpusSection corpus={data.corpus} />
      <BrainTaskMemorySection taskMemories={data.taskMemories} />
    </div>
  );
}
