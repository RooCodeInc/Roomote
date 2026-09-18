'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTOMATION_RECOMMENDATION_CATALOG,
  type AutomationRecommendationBatch,
} from '@roomote/types';
import {
  Alert,
  AlertDescription,
  AlertTriangle,
  Button,
  Checkbox,
  Label,
  Spinner,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { SetupSessionActionCardActions } from './SetupSessionActionCard';

function candidateTitle(candidateId: string) {
  return (
    AUTOMATION_RECOMMENDATION_CATALOG.find(
      (candidate) => candidate.id === candidateId,
    )?.title ?? candidateId
  );
}

export function AutomationRecommendationChoices({
  batch,
  onEnabledChange,
  disabled = false,
}: {
  batch: AutomationRecommendationBatch;
  onEnabledChange: (id: string, enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {batch.recommendations.map((recommendation) => (
        <div key={recommendation.id} className="flex items-start gap-2">
          <Checkbox
            id={`automation-recommendation-${recommendation.id}`}
            className="mt-0.5"
            checked={recommendation.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              onEnabledChange(recommendation.id, enabled === true)
            }
          />
          <Label
            htmlFor={`automation-recommendation-${recommendation.id}`}
            className="min-w-0 flex-1 flex-col items-start gap-1"
          >
            <span className="text-sm font-semibold">
              {candidateTitle(recommendation.candidateId)}
            </span>
            <span className="text-sm font-normal text-muted-foreground">
              {recommendation.explanation}
            </span>
          </Label>
        </div>
      ))}
    </div>
  );
}

export function AutomationRecommendations({
  onContinue,
}: {
  onContinue: (batch: AutomationRecommendationBatch | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const recommendations = useQuery(
    trpc.automations.listRecommendations.queryOptions(undefined, {
      refetchInterval: (query) =>
        query.state.data?.status === 'pending' ? 2_000 : false,
    }),
  );
  const setEnabled = useMutation(
    trpc.automations.setRecommendationEnabled.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.automations.listRecommendations.queryKey(),
        }),
    }),
  );
  const applyRecommendations = useMutation(
    trpc.automations.applyRecommendations.mutationOptions({
      onSuccess: (appliedBatch) => {
        if (appliedBatch) {
          queryClient.setQueryData(
            trpc.automations.listRecommendations.queryKey(),
            appliedBatch,
          );
        }
        onContinue(appliedBatch);
      },
    }),
  );
  const skipRecommendations = useMutation(
    trpc.automations.skipRecommendations.mutationOptions({
      onSuccess: (skippedBatch) => {
        if (skippedBatch) {
          queryClient.setQueryData(
            trpc.automations.listRecommendations.queryKey(),
            skippedBatch,
          );
        }
        onContinue(skippedBatch);
      },
    }),
  );
  const recoveryAttemptedRef = useRef(false);
  const [pendingTooLong, setPendingTooLong] = useState(false);
  const startRecommendations = useMutation(
    trpc.automations.startRecommendations.mutationOptions({
      onSuccess: (batch) => {
        setPendingTooLong(false);
        queryClient.setQueryData(
          trpc.automations.listRecommendations.queryKey(),
          batch,
        );
      },
      onError: (error) => {
        console.error(
          '[AutomationRecommendations] Failed to start recommendation scoring:',
          error,
        );
      },
    }),
  );

  useEffect(() => {
    if (
      recommendations.isPending ||
      recommendations.data?.status === 'ready' ||
      recommendations.data?.status === 'failed' ||
      recoveryAttemptedRef.current
    ) {
      return;
    }

    recoveryAttemptedRef.current = true;
    startRecommendations.mutate();
  }, [
    recommendations.data?.status,
    recommendations.isPending,
    startRecommendations,
  ]);

  const batch = recommendations.data;
  const pending = !batch || batch.status === 'pending';
  const failed = batch?.status === 'failed';
  const handleContinue = () => {
    if (batch?.status === 'ready') {
      if (
        batch.recommendations.some((recommendation) => recommendation.enabled)
      ) {
        applyRecommendations.mutate();
      } else {
        skipRecommendations.mutate();
      }
    }
  };
  const hasSelection =
    batch?.status === 'ready' &&
    batch.recommendations.some((recommendation) => recommendation.enabled);

  useEffect(() => {
    if (!pending) {
      setPendingTooLong(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      console.warn(
        '[AutomationRecommendations] Recommendation scoring is taking longer than expected',
      );
      setPendingTooLong(true);
    }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [pending]);

  return (
    <div className="flex w-full flex-col gap-4">
      {pending ? (
        <div
          className="flex items-start gap-3 text-muted-foreground"
          aria-live="polite"
        >
          <Spinner className="mt-1" />
          <p>
            Roomote is checking your repos for recurring work worth automating.
            <br />
            This only takes a few seconds.
          </p>
        </div>
      ) : failed ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Recommendation review failed before it could be shown. Retry to try
            again.
          </AlertDescription>
        </Alert>
      ) : (
        <AutomationRecommendationChoices
          batch={batch}
          onEnabledChange={(id, enabled) => setEnabled.mutate({ id, enabled })}
          disabled={setEnabled.isPending}
        />
      )}
      {startRecommendations.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            <p>
              Roomote could not start the recommendation review:{' '}
              {startRecommendations.error.message}
            </p>
          </AlertDescription>
        </Alert>
      ) : applyRecommendations.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not enable the selected automations:{' '}
            {applyRecommendations.error.message}
          </AlertDescription>
        </Alert>
      ) : skipRecommendations.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Could not skip the automation recommendations:{' '}
            {skipRecommendations.error.message}
          </AlertDescription>
        </Alert>
      ) : pendingTooLong ? (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Recommendation review is taking longer than expected. You can keep
            waiting or retry it.
          </AlertDescription>
        </Alert>
      ) : null}
      <SetupSessionActionCardActions>
        {(pending || failed) &&
        (startRecommendations.error || pendingTooLong || failed) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setPendingTooLong(false);
              startRecommendations.mutate();
            }}
            disabled={startRecommendations.isPending}
          >
            Retry
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={handleContinue}
          disabled={
            setEnabled.isPending ||
            applyRecommendations.isPending ||
            skipRecommendations.isPending ||
            batch?.status !== 'ready'
          }
        >
          {applyRecommendations.isPending
            ? 'Enabling...'
            : skipRecommendations.isPending
              ? 'Skipping...'
              : hasSelection
                ? 'Enable'
                : 'Skip'}
        </Button>
      </SetupSessionActionCardActions>
    </div>
  );
}
