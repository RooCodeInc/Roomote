import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { z } from 'zod';

import {
  AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
  AUTOMATION_RECOMMENDATION_CATALOG,
  scoreAutomationRecommendations,
  type AutomationRecommendationBatch,
  type RepositoryAutomationSignals,
  type SourceControlProvider,
  normalizeSetupNewState,
} from '@roomote/types';
import {
  db,
  deploymentSettings,
  pullRequestFacts,
  repositories,
  repositoryAutomationSignals,
  and,
  eq,
  gte,
  inArray,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

export const AUTOMATION_RECOMMENDATIONS_QUEUE_NAME =
  'automation-recommendations';
export const AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME =
  'automation-signal-prefetch';
export const AUTOMATION_SIGNALS_VERSION = 1;
export const AUTOMATION_SIGNAL_PREFETCH_CAP = 15;

export const automationRecommendationJobSchema = z.object({
  fingerprint: z.string().min(1),
  repositoryIds: z.array(z.string().uuid()).min(1),
});
export type AutomationRecommendationJob = z.infer<
  typeof automationRecommendationJobSchema
>;

export const automationSignalPrefetchJobSchema = z.object({
  repositoryId: z.string().uuid(),
  signalsVersion: z.number().int().positive(),
});
export type AutomationSignalPrefetchJob = z.infer<
  typeof automationSignalPrefetchJobSchema
>;

let recommendationQueue: Queue<AutomationRecommendationJob> | null = null;
let signalPrefetchQueue: Queue<AutomationSignalPrefetchJob> | null = null;

function getRecommendationQueue() {
  recommendationQueue ??= new Queue<AutomationRecommendationJob>(
    AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 24 * 3_600 },
      },
    },
  );
  return recommendationQueue;
}

function getSignalPrefetchQueue() {
  signalPrefetchQueue ??= new Queue<AutomationSignalPrefetchJob>(
    AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 24 * 3_600, count: 500 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    },
  );
  return signalPrefetchQueue;
}

export function buildAutomationRecommendationFingerprint(
  repositoryIds: readonly string[],
  provider: SourceControlProvider | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repositoryIds: [...repositoryIds].sort(),
        provider,
        catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
      }),
    )
    .digest('hex');
}

export async function enqueueAutomationRecommendations(
  input: AutomationRecommendationJob,
): Promise<void> {
  const request = automationRecommendationJobSchema.parse(input);
  await getRecommendationQueue().add(
    'score-automation-recommendations',
    request,
    {
      jobId: `automation-recommendations-${request.fingerprint}`,
    },
  );
}

export async function enqueueAutomationSignalPrefetch(
  repositoryIds: readonly string[],
): Promise<void> {
  const queue = getSignalPrefetchQueue();
  const collectionDay = new Date().toISOString().slice(0, 10);
  const cappedIds = [...new Set(repositoryIds)].slice(
    0,
    AUTOMATION_SIGNAL_PREFETCH_CAP,
  );

  await Promise.all(
    cappedIds.map((repositoryId) =>
      queue.add(
        'collect-automation-signals',
        { repositoryId, signalsVersion: AUTOMATION_SIGNALS_VERSION },
        {
          jobId: `automation-signals-${repositoryId}-${AUTOMATION_SIGNALS_VERSION}-${collectionDay}`,
        },
      ),
    ),
  );
}

async function collectSignals(
  repositoryId: string,
): Promise<RepositoryAutomationSignals> {
  const [repository] = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  if (!repository) throw new Error(`Repository ${repositoryId} was not found.`);

  const facts = await db
    .select({
      state: pullRequestFacts.state,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
    })
    .from(pullRequestFacts)
    .where(eq(pullRequestFacts.repositoryId, repositoryId));
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return {
    repositoryId: repository.id,
    repositoryName: repository.fullName,
    sourceControlProvider: repository.sourceControlProvider,
    mergedPrs30d: facts.filter(
      (fact) =>
        fact.state === 'merged' &&
        fact.mergedAtRemote &&
        fact.mergedAtRemote.getTime() >= since,
    ).length,
    openPrs: facts.filter(
      (fact) => fact.state === 'open' || fact.state === 'draft',
    ).length,
    conflicts: 0,
    ciFailures30d: 0,
    dependabotAlerts: 0,
    codeqlAlerts: 0,
    dependencyManifests: 0,
    docs: 0,
    partial: true,
  };
}

export async function collectAutomationSignalsJob(
  input: AutomationSignalPrefetchJob,
): Promise<void> {
  const request = automationSignalPrefetchJobSchema.parse(input);
  const payload = await collectSignals(request.repositoryId);
  await db
    .insert(repositoryAutomationSignals)
    .values({
      repositoryId: request.repositoryId,
      signalsVersion: request.signalsVersion,
      payload,
      partial: payload.partial ?? false,
    })
    .onConflictDoUpdate({
      target: [
        repositoryAutomationSignals.repositoryId,
        repositoryAutomationSignals.signalsVersion,
      ],
      set: {
        payload,
        partial: payload.partial ?? false,
        collectedAt: new Date(),
      },
    });
}

function mergeRecommendationState(
  batch: AutomationRecommendationBatch,
  previous: AutomationRecommendationBatch | null,
): AutomationRecommendationBatch {
  if (!previous || previous.inputFingerprint !== batch.inputFingerprint) {
    return batch;
  }

  return {
    ...batch,
    dismissed: previous.dismissed,
    recommendations: batch.recommendations.map((recommendation) => {
      const existing = previous.recommendations.find(
        (item) => item.candidateId === recommendation.candidateId,
      );
      return existing
        ? {
            ...recommendation,
            enabled: existing.enabled,
            lastRunTaskId: existing.lastRunTaskId,
            automationId: existing.automationId,
          }
        : recommendation;
    }),
  };
}

async function buildRecommendationBatch(
  repositoryIds: readonly string[],
  fingerprint: string,
): Promise<AutomationRecommendationBatch> {
  const repositoriesForSelection = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(inArray(repositories.id, [...repositoryIds]));

  const cached = await db
    .select({ payload: repositoryAutomationSignals.payload })
    .from(repositoryAutomationSignals)
    .where(
      and(
        eq(
          repositoryAutomationSignals.signalsVersion,
          AUTOMATION_SIGNALS_VERSION,
        ),
        gte(
          repositoryAutomationSignals.collectedAt,
          new Date(Date.now() - 24 * 60 * 60 * 1_000),
        ),
        inArray(
          repositoryAutomationSignals.repositoryId,
          repositoriesForSelection.map((repository) => repository.id),
        ),
      ),
    );
  const cachedByRepositoryId = new Map(
    cached
      .map((row) => row.payload)
      .filter(
        (payload): payload is RepositoryAutomationSignals =>
          payload !== null &&
          payload !== undefined &&
          payload.repositoryId !== undefined,
      )
      .map((payload) => [payload.repositoryId, payload]),
  );

  const signals = await Promise.all(
    repositoriesForSelection.map(async (repository) => {
      const existing = cachedByRepositoryId.get(repository.id);
      if (existing) return existing;
      const collected = await collectSignals(repository.id);
      await db
        .insert(repositoryAutomationSignals)
        .values({
          repositoryId: repository.id,
          signalsVersion: AUTOMATION_SIGNALS_VERSION,
          payload: collected,
          partial: collected.partial ?? false,
        })
        .onConflictDoUpdate({
          target: [
            repositoryAutomationSignals.repositoryId,
            repositoryAutomationSignals.signalsVersion,
          ],
          set: {
            payload: collected,
            partial: collected.partial ?? false,
            collectedAt: new Date(),
          },
        });
      return collected;
    }),
  );

  const merged = signals.reduce(
    (result, signal) => ({
      repositoryCount: result.repositoryCount + 1,
      sourceControlProviders: [
        ...new Set([
          ...result.sourceControlProviders,
          signal.sourceControlProvider,
        ]),
      ],
      mergedPrs30d: result.mergedPrs30d + signal.mergedPrs30d,
      openPrs: result.openPrs + signal.openPrs,
      conflicts: result.conflicts + signal.conflicts,
      ciFailures30d: result.ciFailures30d + signal.ciFailures30d,
      dependabotAlerts: result.dependabotAlerts + signal.dependabotAlerts,
      codeqlAlerts: result.codeqlAlerts + signal.codeqlAlerts,
      dependencyManifests:
        result.dependencyManifests + signal.dependencyManifests,
      docs: result.docs + signal.docs,
    }),
    {
      repositoryCount: 0,
      sourceControlProviders: [] as SourceControlProvider[],
      mergedPrs30d: 0,
      openPrs: 0,
      conflicts: 0,
      ciFailures30d: 0,
      dependabotAlerts: 0,
      codeqlAlerts: 0,
      dependencyManifests: 0,
      docs: 0,
    },
  );
  const scored = scoreAutomationRecommendations(merged, {
    catalog: AUTOMATION_RECOMMENDATION_CATALOG,
  });
  const now = new Date().toISOString();

  return {
    version: 1,
    inputFingerprint: fingerprint,
    catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
    status: 'ready',
    startedAt: now,
    completedAt: now,
    partial: signals.some((signal) => signal.partial === true),
    errorCode: null,
    dismissed: false,
    recommendations: scored.map(({ candidate, score, explanation }, index) => ({
      id: `${candidate.id}:${index + 1}`,
      candidateId: candidate.id,
      rank: index + 1,
      score,
      explanation,
      enabled: true,
      lastRunTaskId: null,
      automationId: null,
    })),
  };
}

export async function processAutomationRecommendationsJob(
  input: AutomationRecommendationJob,
): Promise<void> {
  const request = automationRecommendationJobSchema.parse(input);
  const [settings] = await db
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);
  const state = normalizeSetupNewState(settings?.setupNewState ?? {});
  if (
    state.automationRecommendations?.inputFingerprint !== request.fingerprint
  ) {
    return;
  }

  try {
    const batch = await buildRecommendationBatch(
      request.repositoryIds,
      request.fingerprint,
    );
    const latest = await db
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const latestState = normalizeSetupNewState(
      latest?.[0]?.setupNewState ?? {},
    );
    if (
      latestState.automationRecommendations?.inputFingerprint !==
      request.fingerprint
    ) {
      return;
    }
    const nextState = normalizeSetupNewState({
      ...latestState,
      automationRecommendations: mergeRecommendationState(
        batch,
        latestState.automationRecommendations,
      ),
    });
    await db
      .update(deploymentSettings)
      .set({ setupNewState: nextState, updatedAt: new Date() })
      .where(eq(deploymentSettings.id, 'default'));
  } catch (error) {
    const current = await db
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const currentState = normalizeSetupNewState(
      current[0]?.setupNewState ?? {},
    );
    if (
      currentState.automationRecommendations?.inputFingerprint !==
      request.fingerprint
    ) {
      return;
    }
    const failedBatch = {
      ...currentState.automationRecommendations,
      status: 'failed' as const,
      completedAt: new Date().toISOString(),
      errorCode: 'recommendation_generation_failed',
    };
    await db
      .update(deploymentSettings)
      .set({
        setupNewState: normalizeSetupNewState({
          ...currentState,
          automationRecommendations: failedBatch,
        }),
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
    throw error;
  }
}
