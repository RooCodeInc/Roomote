'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTOMATION_RECOMMENDATION_CATALOG } from '@roomote/types';
import {
  ArrowRight,
  Loader2,
  Play,
  Switch,
  Button,
  Card,
  CardContent,
} from '@/components/system';
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
        text={pending ? 'Looking for stuff to automate' : STEP.title}
      />
      {pending ? (
        <div
          className="flex items-center gap-3 text-muted-foreground"
          aria-live="polite"
        >
          <Loader2 className="size-5 animate-spin" />
          <p>
            Roomote is checking the selected repositories for recurring work
            worth automating.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {batch.recommendations.map((recommendation) => (
            <Card key={recommendation.id}>
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
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
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate({ id: recommendation.id })}
                  title="Starts a paid automation run"
                >
                  <Play />
                  Run now
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <SetupFooter onBack={onBack}>
        <Button type="button" onClick={onContinue} className="ml-auto">
          Continue
          <ArrowRight />
        </Button>
      </SetupFooter>
    </div>
  );
}
