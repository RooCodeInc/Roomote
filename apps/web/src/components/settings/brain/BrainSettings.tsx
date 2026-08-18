'use client';

import { useQuery } from '@tanstack/react-query';

import { ErrorState, Skeleton } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { BrainCorpusSection } from './BrainCorpusSection';
import { BrainSourcesSection } from './BrainSourcesSection';
import { BrainStatusSection } from './BrainStatusSection';
import { BrainTaskMemorySection } from './BrainTaskMemorySection';

function BrainSettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
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

  return (
    <div className="space-y-6">
      <BrainStatusSection settings={data} />

      {/*
       * A deployment without a Brain has no corpus, no collector checkpoints,
       * and no outbox worth reading: the sections below would all render the
       * same empty state, which reads as breakage rather than as an
       * unconfigured feature.
       */}
      {data.status !== 'not_configured' ? (
        <>
          <BrainCorpusSection corpus={data.corpus} />
          <BrainSourcesSection sources={data.sources} />
          <BrainTaskMemorySection taskMemories={data.taskMemories} />
        </>
      ) : null}
    </div>
  );
}
