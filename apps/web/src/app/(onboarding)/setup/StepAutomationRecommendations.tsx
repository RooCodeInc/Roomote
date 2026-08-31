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
  ArrowRight,
  Switch,
  Button,
  Label,
  Spinner,
  Zap,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { SetupFooter } from './SetupFooter';
import { StepTitle } from './StepTitle';

function candidateTitle(candidateId: string) {
  return (
    AUTOMATION_RECOMMENDATION_CATALOG.find(
      (candidate) => candidate.id === candidateId,
    )?.title ?? candidateId
  );
}

export function StepAutomationRecommendations({
  onContinue,
  onBack,
  embedded = false,
}: {
  onContinue: (batch: AutomationRecommendationBatch | null) => void;
  onBack?: () => void;
  /** The setup-session action card supplies the heading and introduction. */
  embedded?: boolean;
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
          '[StepAutomationRecommendations] Failed to start recommendation scoring:',
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
      applyRecommendations.mutate();
      return;
    }
    if (pending || failed) {
      skipRecommendations.mutate();
      return;
    }
    onContinue(batch);
  };

  useEffect(() => {
    if (!pending) {
      setPendingTooLong(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      console.warn(
        '[StepAutomationRecommendations] Recommendation scoring is taking longer than expected',
      );
      setPendingTooLong(true);
    }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [pending]);

  return (
    <div
      className={
        embedded
          ? 'flex w-full flex-col gap-4'
          : 'mx-auto flex w-full max-w-3xl flex-col gap-8'
      }
    >
      {!embedded ? (
        <StepTitle
          text={
            pending
              ? 'Looking for stuff to automate...'
              : 'Recommended automations'
          }
        />
      ) : null}
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
            again, or continue without reviewing automations.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          {!embedded ? (
            <p className="text-muted-foreground">
              After analyzing your connected repos, Roomote found some
              automations to make your life easier:
            </p>
          ) : null}
          <div className="divide-y-2 divide-accent-bright-foreground bg-card rounded-xl">
            {batch.recommendations.map((recommendation) => (
              <div
                key={recommendation.id}
                className="flex flex-col gap-4 py-3 px-4 sm:flex-row sm:items-center"
              >
                <Switch
                  id={`automation-recommendation-${recommendation.id}`}
                  checked={recommendation.enabled}
                  onCheckedChange={(enabled) =>
                    setEnabled.mutate({ id: recommendation.id, enabled })
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
          <p>
            You can manage these (and dozens of others) and create your own in
            the <Zap className="inline size-4 ml-0.5 -mt-0.5" /> Automations
            page.
          </p>
        </div>
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
            Could not skip the recommendation review:{' '}
            {skipRecommendations.error.message}
          </AlertDescription>
        </Alert>
      ) : pendingTooLong ? (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertDescription>
            Recommendation review is taking longer than expected. You can keep
            waiting, retry it, or continue without reviewing automations.
          </AlertDescription>
        </Alert>
      ) : null}
      <SetupFooter onBack={onBack}>
        {(pending || failed) &&
        (startRecommendations.error || pendingTooLong || failed) ? (
          <Button
            type="button"
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
          onClick={handleContinue}
          disabled={
            setEnabled.isPending ||
            applyRecommendations.isPending ||
            skipRecommendations.isPending
          }
        >
          {applyRecommendations.isPending
            ? 'Applying...'
            : pending
              ? 'Skip'
              : 'Continue'}
          <ArrowRight />
        </Button>
      </SetupFooter>
    </div>
  );
}
