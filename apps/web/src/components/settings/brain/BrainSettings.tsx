'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { ErrorState, Skeleton } from '@/components/system';
import { useTRPC } from '@/trpc/client';

import { BrainConfigurationSection } from './BrainConfigurationSection';
import { BrainCorpusSection } from './BrainCorpusSection';
import { BrainBrowseSection } from './BrainBrowseSection';
import { BrainMemoryIssuesSection } from './BrainMemoryIssuesSection';
import { BrainSourcesSection } from './BrainSourcesSection';
import { BrainStatusSection } from './BrainStatusSection';

function BrainSettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-80 w-full" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function BrainSettings() {
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isPending, isError } = useQuery(trpc.brain.get.queryOptions());
  const selectedSlug = searchParams.get('memory');
  const [namespaceId, setNamespaceId] = useState<string | null>(null);
  const selectMemory = useCallback(
    (slug: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (slug) {
        params.set('memory', slug);
      } else {
        params.delete('memory');
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );
  const selectNamespace = useCallback(
    (nextNamespaceId: string | null) => {
      setNamespaceId(nextNamespaceId);
      if (selectedSlug) {
        selectMemory(null);
      }
    },
    [selectMemory, selectedSlug],
  );

  if (isPending) {
    return <BrainSettingsSkeleton />;
  }

  if (isError) {
    return <ErrorState title="Failed to load Memory" />;
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
      <BrainMemoryIssuesSection taskMemories={data.taskMemories} />
      <BrainCorpusSection
        corpus={data.corpus}
        onSelectNamespace={selectNamespace}
      />
      <BrainBrowseSection
        corpus={data.corpus}
        namespaceId={namespaceId}
        selectedSlug={selectedSlug}
        onSelectNamespace={selectNamespace}
        onSelectMemory={selectMemory}
      />
      <BrainStatusSection settings={data} />
      <BrainSourcesSection sources={data.sources} />
      <BrainConfigurationSection settings={data} />
    </div>
  );
}
