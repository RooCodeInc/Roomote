'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import { Skeleton, Switch } from '@/components/system';
import { Section } from '@/components/settings';
import type { ExperimentalFlag } from '@/trpc/commands/feature-flags';

export function ExperimentalSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.featureFlags.getExperimental.queryKey();
  const flagsQuery = useQuery(trpc.featureFlags.getExperimental.queryOptions());
  const updateMutation = useMutation(
    trpc.featureFlags.setExperimental.mutationOptions(),
  );

  const handleToggle = async (flag: ExperimentalFlag, nextValue: boolean) => {
    const previous = flagsQuery.data;
    queryClient.setQueryData<ExperimentalFlag[]>(queryKey, (current) =>
      (current ?? []).map((item) =>
        item.id === flag.id ? { ...item, value: nextValue } : item,
      ),
    );

    try {
      const updated = await updateMutation.mutateAsync({
        flag: flag.id,
        value: nextValue,
      });
      queryClient.setQueryData<ExperimentalFlag[]>(queryKey, updated);
      toast.success(`${flag.name} ${nextValue ? 'enabled' : 'disabled'}`);
    } catch (error) {
      queryClient.setQueryData<ExperimentalFlag[]>(queryKey, previous);
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to update feature flag.',
      );
    }
  };

  if (flagsQuery.isPending) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (flagsQuery.isError || !flagsQuery.data) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>Failed to load feature flags.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {flagsQuery.data.map((flag) => (
        <Section
          key={flag.id}
          title={flag.name}
          action={
            <Switch
              aria-label={`Toggle ${flag.name}`}
              checked={flag.value}
              disabled={updateMutation.isPending}
              onCheckedChange={(checked) =>
                void handleToggle(flag, checked === true)
              }
            />
          }
        >
          <p className="text-sm text-muted-foreground">{flag.description}</p>
        </Section>
      ))}
    </div>
  );
}
