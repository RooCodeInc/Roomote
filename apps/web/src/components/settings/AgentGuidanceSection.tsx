'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  AlertCircle,
  ScrollText,
  Button,
  Label,
  Skeleton,
  Spinner,
  Textarea,
} from '@/components/system';

import { Section } from '@/components/settings';

export function AgentGuidanceSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQueryKey = trpc.agentBehavior.get.queryKey();
  const settingsQuery = useQuery(trpc.agentBehavior.get.queryOptions());
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [hasLoadedInitialValue, setHasLoadedInitialValue] = useState(false);

  const updateMutation = useMutation(
    trpc.agentBehavior.update.mutationOptions({
      onSuccess: (result) => {
        if (!result.success) {
          return;
        }

        queryClient.setQueryData(settingsQueryKey, result.settings);
        const nextValue = result.settings.globalAgentInstructions ?? '';
        setValue(nextValue);
        setSavedValue(nextValue);
        toast.success('Agent guidance saved.');
      },
      onError: () => {
        toast.error('Failed to save agent guidance.');
      },
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: settingsQueryKey,
        });
      },
    }),
  );

  const serverValue = settingsQuery.data?.globalAgentInstructions ?? '';
  const isDirty = value !== savedValue;
  const hasLoadError =
    !settingsQuery.data &&
    (settingsQuery.isError ||
      (settingsQuery.isFetching && settingsQuery.errorUpdatedAt > 0));

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    if (!hasLoadedInitialValue || !isDirty) {
      setValue(serverValue);
      setSavedValue(serverValue);
      setHasLoadedInitialValue(true);
    }
  }, [hasLoadedInitialValue, isDirty, serverValue, settingsQuery.data]);

  const fieldError =
    updateMutation.data && !updateMutation.data.success
      ? updateMutation.data.fieldErrors.globalAgentInstructions
      : undefined;

  const footer =
    !isDirty && !updateMutation.isPending ? undefined : (
      <>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setValue(savedValue);
            updateMutation.reset();
          }}
          disabled={updateMutation.isPending}
        >
          Reset
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateMutation.mutate({
              globalAgentInstructions: value || null,
            })
          }
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </>
    );

  return (
    <Section icon={ScrollText} title="Shared Agent Guidance" footer={footer}>
      <div className="space-y-3">
        <p>
          Instructions included in the context of all sessions and tasks,
          irrespective of environment or repo. Think of it like a global
          AGENTS.MD file across all of Roomote.
        </p>
        {hasLoadError ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <p className="grow text-destructive">
              Failed to load agent guidance settings.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={settingsQuery.isFetching}
              aria-busy={settingsQuery.isFetching}
              onClick={() => void settingsQuery.refetch()}
            >
              {settingsQuery.isFetching ? <Spinner /> : null}
              {settingsQuery.isFetching ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        ) : settingsQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="global-agent-instructions" className="sr-only">
              Shared Agent Guidance
            </Label>
            <Textarea
              id="global-agent-instructions"
              value={value}
              onChange={(event) => {
                if (fieldError) {
                  updateMutation.reset();
                }

                setValue(event.target.value);
              }}
              className="min-h-64"
              rows={14}
              placeholder="Optional guidance for deployment-wide coding style, communication preferences, or delivery expectations"
              disabled={updateMutation.isPending}
            />
            {fieldError && (
              <p className="text-xs text-destructive">{fieldError}</p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
