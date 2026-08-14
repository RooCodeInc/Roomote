'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTOMATION_RECOMMENDATION_CATALOG,
  type AutomationRecommendationBatch,
} from '@roomote/types';
import {
  Button,
  Card,
  CardContent,
  Loader2,
  Play,
  Switch,
  X,
} from '@/components/system';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

function candidateTitle(candidateId: string) {
  return (
    AUTOMATION_RECOMMENDATION_CATALOG.find(
      (candidate) => candidate.id === candidateId,
    )?.title ?? candidateId
  );
}

export function AutomationRecommendationsCard() {
  const { user } = useUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(
    trpc.automations.listRecommendations.queryOptions(undefined, {
      enabled: user?.isAdmin === true,
    }),
  );
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.automations.listRecommendations.queryKey(),
    });
  const setEnabled = useMutation(
    trpc.automations.setRecommendationEnabled.mutationOptions({
      onSettled: invalidate,
    }),
  );
  const runNow = useMutation(
    trpc.automations.runRecommendationNow.mutationOptions({
      onSettled: invalidate,
    }),
  );
  const dismiss = useMutation(
    trpc.automations.dismissRecommendationsCard.mutationOptions({
      onSettled: invalidate,
    }),
  );

  const batch = query.data as AutomationRecommendationBatch | null | undefined;
  if (
    !user?.isAdmin ||
    !batch ||
    batch.dismissed ||
    batch.recommendations.length === 0
  ) {
    return null;
  }
  const untouched = batch.recommendations.some(
    (recommendation) =>
      !recommendation.enabled && !recommendation.lastRunTaskId,
  );
  if (!untouched) return null;

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Automation recommendations</h2>
            <p className="text-sm text-muted-foreground">
              A few recurring jobs Roomote found in your repositories.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => dismiss.mutate()}
            aria-label="Dismiss automation recommendations"
          >
            <X />
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {batch.recommendations.map((recommendation) => (
            <div
              key={recommendation.id}
              className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center"
            >
              <Switch
                checked={recommendation.enabled}
                onCheckedChange={(enabled) =>
                  setEnabled.mutate({ id: recommendation.id, enabled })
                }
                aria-label={`Enable ${candidateTitle(recommendation.candidateId)}`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
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
                {runNow.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                Run now
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
