'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTOMATION_RECOMMENDATION_CATALOG } from '@roomote/types';
import { ArrowRight, Play, Switch, Button, Spinner } from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { SetupFooter } from './SetupFooter';
import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const STEP = getSetupStepDefinition('automation-recommendations');

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
}: {
  onContinue: () => void;
  onBack?: () => void;
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
  const runNow = useMutation(
    trpc.automations.runRecommendationNow.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.automations.listRecommendations.queryKey(),
        }),
    }),
  );
  const recoveryAttemptedRef = useRef(false);
  const startRecommendations = useMutation(
    trpc.automations.startRecommendations.mutationOptions({
      onSuccess: (batch) => {
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
        onContinue();
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
    onContinue,
    recommendations.data?.status,
    recommendations.isPending,
    startRecommendations,
  ]);

  useEffect(() => {
    if (recommendations.data?.status === 'failed') onContinue();
  }, [onContinue, recommendations.data?.status]);
  useEffect(() => {
    if (recommendations.data?.status !== 'pending') return;
    const timeout = window.setTimeout(onContinue, 30_000);
    return () => window.clearTimeout(timeout);
  }, [onContinue, recommendations.data?.status]);

  const batch = recommendations.data;
  const pending = !batch || batch.status === 'pending';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <StepTitle
        text={pending ? 'Looking for stuff to automate...' : STEP.title}
      />
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
      ) : (
        <div className="space-y-4">
          <p className="text-muted-foreground">
            Considering the shape and update frequency of your connected
            repositories, Roomote found some automations that can help you save
            work:
          </p>
          <div className="divide-y divide-foreground/10">
            {batch.recommendations.map((recommendation) => (
              <div
                key={recommendation.id}
                className="flex flex-col gap-4 py-3 sm:flex-row sm:items-center"
              >
                <Switch
                  checked={recommendation.enabled}
                  onCheckedChange={(enabled) =>
                    setEnabled.mutate({ id: recommendation.id, enabled })
                  }
                  aria-label={`Enable ${recommendation.candidateId}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {candidateTitle(recommendation.candidateId)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {recommendation.explanation}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate({ id: recommendation.id })}
                  title="Starts a paid automation run"
                >
                  <Play />
                  Run now
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <SetupFooter onBack={onBack}>
        <Button type="button" onClick={onContinue}>
          {pending ? 'Skip' : 'Continue'}
          <ArrowRight />
        </Button>
      </SetupFooter>
    </div>
  );
}
