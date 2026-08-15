import {
  ALL_REPOSITORIES,
  normalizeRepositorySelection,
  normalizeSetupNewState,
  sourceControlTokenBackedProviders,
  type AutomationRecommendationBatch,
  type SourceControlProvider,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import {
  and,
  createCustomAutomation,
  db,
  deploymentSettings,
  eq,
  getCustomAutomationById,
  githubInstallations,
  gte,
  inArray,
  isNull,
  or,
  pullRequestFacts,
  repositories,
  sql,
  updateCustomAutomation,
  upsertAutomation,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { captureActivationAutomationChanged } from '@roomote/telemetry/server';

import type { AutomationRunNowResult } from '../automations/types';
import {
  AUTOMATION_RECOMMENDATION_REPOSITORY_CAP,
  buildAutomationRecommendationFingerprint,
  enqueueAutomationRecommendationInitialRun,
  enqueueAutomationRecommendations,
  enqueueAutomationSignalPrefetch,
} from './automation-recommendation-queues';
import {
  AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
  AUTOMATION_RECOMMENDATION_CATALOG,
  type AutomationRecommendationCandidate,
} from './automation-recommendations-policy';

const AUTOMATION_RECOMMENDATION_TRIGGER_DELAY_MS = 5 * 60 * 1_000;

type PersistedSetupNewState = ReturnType<typeof normalizeSetupNewState>;

async function getSetupState(
  executor: DatabaseOrTransaction = db,
): Promise<PersistedSetupNewState> {
  const [settings] = await executor
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);
  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

async function saveSetupState(
  setupNewState: PersistedSetupNewState,
  executor: DatabaseOrTransaction = db,
) {
  await executor
    .insert(deploymentSettings)
    .values({ id: 'default', setupNewState })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: { setupNewState, updatedAt: new Date() },
    });
}

async function withRecommendationLock<T>(
  update: (
    state: PersistedSetupNewState,
    tx: DatabaseOrTransaction,
  ) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    return update(await getSetupState(tx), tx);
  });
}

function candidateFor(candidateId: string) {
  return AUTOMATION_RECOMMENDATION_CATALOG.find(
    (candidate) => candidate.id === candidateId,
  );
}

function hydrateRecommendationBatch(
  batch: AutomationRecommendationBatch | null | undefined,
): AutomationRecommendationBatch | null {
  if (!batch) return null;
  return {
    ...batch,
    recommendations: batch.recommendations.map((recommendation) => ({
      ...recommendation,
      title:
        recommendation.title ??
        candidateFor(recommendation.candidateId)?.title ??
        recommendation.candidateId,
    })),
  };
}

export function createPendingAutomationRecommendationBatch(
  inputFingerprint: string,
  previousBatch: AutomationRecommendationBatch | null | undefined,
): AutomationRecommendationBatch {
  const sameInput = previousBatch?.inputFingerprint === inputFingerprint;
  return {
    version: 1,
    inputFingerprint,
    catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
    status: 'pending',
    startedAt: new Date().toISOString(),
    completedAt: null,
    partial: false,
    errorCode: null,
    dismissed: sameInput ? previousBatch.dismissed : false,
    applicationState: sameInput
      ? (previousBatch.applicationState ?? 'pending')
      : 'pending',
    recommendations: sameInput ? previousBatch.recommendations : [],
  };
}

export async function markAutomationRecommendationBatchFailed(
  inputFingerprint: string,
  errorCode: string,
) {
  await updateSetupAutomationRecommendationBatchIfCurrent(
    inputFingerprint,
    (batch) => ({
      ...batch,
      status: 'failed',
      completedAt: new Date().toISOString(),
      errorCode,
    }),
  );
}

export async function isSetupAutomationRecommendationFingerprintCurrent(
  inputFingerprint: string,
) {
  return (
    (await getSetupState()).automationRecommendations?.inputFingerprint ===
    inputFingerprint
  );
}

export async function updateSetupAutomationRecommendationBatchIfCurrent(
  inputFingerprint: string,
  update: (
    batch: AutomationRecommendationBatch,
  ) => AutomationRecommendationBatch,
) {
  return withRecommendationLock(async (state, tx) => {
    const current = state.automationRecommendations;
    if (current?.inputFingerprint !== inputFingerprint) return null;
    const batch = update(current);
    await saveSetupState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
    return batch;
  });
}

export async function resolveConnectedAutomationRecommendationRepositories(): Promise<{
  normalizedRepositoryIds: string[];
  connectedRepositories: Array<{
    id: string;
    fullName: string;
    sourceControlProvider: SourceControlProvider;
  }>;
}> {
  const connectedRepositories = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .leftJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.isActive, true),
        or(
          inArray(
            repositories.sourceControlProvider,
            sourceControlTokenBackedProviders,
          ),
          and(
            eq(repositories.sourceControlProvider, 'github'),
            isNull(githubInstallations.suspendedAt),
          ),
        ),
      ),
    );
  const activitySince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const activityRows =
    connectedRepositories.length > 0
      ? await db
          .select({
            repositoryId: pullRequestFacts.repositoryId,
            activity: sql<number>`count(*)::int`,
          })
          .from(pullRequestFacts)
          .where(
            and(
              inArray(
                pullRequestFacts.repositoryId,
                connectedRepositories.map((repository) => repository.id),
              ),
              gte(pullRequestFacts.updatedAtRemote, activitySince),
            ),
          )
          .groupBy(pullRequestFacts.repositoryId)
      : [];
  const activityByRepositoryId = new Map(
    activityRows.map((row) => [row.repositoryId, row.activity]),
  );
  const rankedRepositories = [...connectedRepositories]
    .sort(
      (left, right) =>
        (activityByRepositoryId.get(right.id) ?? 0) -
          (activityByRepositoryId.get(left.id) ?? 0) ||
        left.fullName.localeCompare(right.fullName),
    )
    .slice(0, AUTOMATION_RECOMMENDATION_REPOSITORY_CAP);
  return {
    normalizedRepositoryIds: normalizeRepositorySelection(rankedRepositories),
    connectedRepositories: rankedRepositories,
  };
}

export async function prefetchSetupAutomationRecommendationSignals() {
  const { normalizedRepositoryIds } =
    await resolveConnectedAutomationRecommendationRepositories();
  await enqueueAutomationSignalPrefetch(normalizedRepositoryIds);
  return { repositoryIds: normalizedRepositoryIds };
}

export async function prepareSetupAutomationRecommendationInput() {
  const { normalizedRepositoryIds, connectedRepositories } =
    await resolveConnectedAutomationRecommendationRepositories();
  return {
    fingerprint: buildAutomationRecommendationFingerprint(
      normalizedRepositoryIds,
      connectedRepositories[0]?.sourceControlProvider ?? null,
    ),
    repositoryIds: normalizedRepositoryIds,
  };
}

export async function dispatchSetupAutomationRecommendationBatch(input: {
  batch: AutomationRecommendationBatch;
  repositoryIds: string[];
  logContext: string;
}) {
  try {
    await enqueueAutomationRecommendations({
      fingerprint: input.batch.inputFingerprint,
      repositoryIds: input.repositoryIds,
    });
  } catch (error) {
    console.error(
      `[${input.logContext}] Failed to enqueue recommendation scoring:`,
      error,
    );
    await markAutomationRecommendationBatchFailed(
      input.batch.inputFingerprint,
      'recommendation_queue_unavailable',
    );
  }
}

async function applyRecommendation(
  tx: DatabaseOrTransaction,
  userId: string,
  recommendation: AutomationRecommendationBatch['recommendations'][number],
  enabled: boolean,
  candidate: AutomationRecommendationCandidate,
): Promise<string | null> {
  if (candidate.source === 'built_in') {
    await upsertAutomation(tx, {
      key: candidate.automationKey,
      enabled,
      schedule: { mode: enabled ? candidate.defaultScheduleMode : 'off' },
    });
    return null;
  }
  const existing = recommendation.automationId
    ? await getCustomAutomationById(recommendation.automationId, tx)
    : null;
  const automation = existing
    ? await updateCustomAutomation(
        existing.id,
        {
          name: candidate.template.name,
          prompt: candidate.template.prompt,
          enabled,
          scheduleMode: candidate.template.scheduleMode,
          environmentId: ALL_REPOSITORIES,
          target: {},
        },
        tx,
      )
    : await createCustomAutomation(
        {
          name: candidate.template.name,
          prompt: candidate.template.prompt,
          enabled,
          scheduleMode: candidate.template.scheduleMode,
          environmentId: ALL_REPOSITORIES,
          target: {},
          createdByUserId: userId,
        },
        tx,
      );
  return automation.id;
}

export async function setSetupAutomationRecommendationEnabled(input: {
  userId: string;
  id: string;
  enabled: boolean;
}) {
  const result = await withRecommendationLock(async (state, tx) => {
    const batch = state.automationRecommendations;
    const recommendation = batch?.recommendations.find(
      (item) => item.id === input.id,
    );
    if (!batch || !recommendation) {
      throw new Error('Recommendation was not found.');
    }
    const candidate = candidateFor(recommendation.candidateId);
    if (!candidate) throw new Error('Recommendation candidate was not found.');
    const automationId = await applyRecommendation(
      tx,
      input.userId,
      recommendation,
      input.enabled,
      candidate,
    );
    const nextBatch = {
      ...batch,
      recommendations: batch.recommendations.map((item) =>
        item.id === input.id
          ? {
              ...item,
              title: candidate.title,
              enabled: input.enabled,
              applied: true,
              ...(automationId ? { automationId } : {}),
            }
          : item,
      ),
    };
    await saveSetupState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return {
      recommendation: nextBatch.recommendations.find(
        (item) => item.id === input.id,
      ),
      candidate,
    };
  });
  if (
    result.recommendation?.enabled &&
    result.candidate.source === 'built_in'
  ) {
    void captureActivationAutomationChanged(
      'enabled',
      result.candidate.automationKey,
    );
  }
  return result.recommendation;
}

export async function applySetupAutomationRecommendations(userId: string) {
  const batch = await withRecommendationLock(async (state, tx) => {
    const batch = state.automationRecommendations;
    if (!batch || batch.status !== 'ready') return batch;
    const recommendations = [];
    for (const recommendation of batch.recommendations) {
      const candidate = candidateFor(recommendation.candidateId);
      if (!candidate) {
        throw new Error('Recommendation candidate was not found.');
      }
      const automationId = await applyRecommendation(
        tx,
        userId,
        recommendation,
        recommendation.enabled,
        candidate,
      );
      recommendations.push({
        ...recommendation,
        title: candidate.title,
        applied: true,
        ...(automationId ? { automationId } : {}),
      });
    }
    const nextBatch = {
      ...batch,
      applicationState: 'applied' as const,
      recommendations,
    };
    await saveSetupState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return nextBatch;
  });
  for (const recommendation of batch?.recommendations ?? []) {
    if (!recommendation.enabled) continue;
    const candidate = candidateFor(recommendation.candidateId);
    if (candidate?.source === 'built_in') {
      void captureActivationAutomationChanged(
        'enabled',
        candidate.automationKey,
      );
    }
  }
  await Promise.all(
    (batch?.recommendations ?? [])
      .filter((recommendation) => recommendation.enabled)
      .filter((recommendation) => {
        const candidate = candidateFor(recommendation.candidateId);
        return !(
          candidate?.source === 'built_in' &&
          candidate.automationKey === 'review_code'
        );
      })
      .map(async (recommendation) => {
        try {
          await enqueueAutomationRecommendationInitialRun(
            {
              fingerprint: batch!.inputFingerprint,
              recommendationId: recommendation.id,
            },
            AUTOMATION_RECOMMENDATION_TRIGGER_DELAY_MS,
          );
        } catch (error) {
          console.error(
            `[applySetupAutomationRecommendations] Failed to schedule ${recommendation.id}:`,
            error,
          );
        }
      }),
  );
  return hydrateRecommendationBatch(batch);
}

export async function skipSetupAutomationRecommendations() {
  return withRecommendationLock(async (state, tx) => {
    const batch = state.automationRecommendations;
    if (!batch || (batch.applicationState ?? 'pending') !== 'pending') {
      return hydrateRecommendationBatch(batch);
    }
    const nextBatch = {
      ...batch,
      applicationState: 'skipped' as const,
      recommendations: batch.recommendations.map((recommendation) => ({
        ...recommendation,
        enabled: false,
        applied: false,
      })),
    };
    await saveSetupState(
      normalizeSetupNewState({
        ...state,
        automationRecommendations: nextBatch,
      }),
      tx,
    );
    return hydrateRecommendationBatch(nextBatch);
  });
}

export async function listSetupAutomationRecommendations() {
  return hydrateRecommendationBatch(
    (await getSetupState()).automationRecommendations,
  );
}

export async function startSetupAutomationRecommendations() {
  const input = await prepareSetupAutomationRecommendationInput();
  const result = await withRecommendationLock(async (state, tx) => {
    const existingBatch = state.automationRecommendations;
    const batch = {
      ...(existingBatch?.inputFingerprint === input.fingerprint
        ? existingBatch
        : {
            version: 1 as const,
            inputFingerprint: input.fingerprint,
            catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
            completedAt: null,
            partial: false,
            dismissed: false,
            applicationState: 'pending' as const,
            recommendations: [],
          }),
      status: 'pending' as const,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorCode: null,
    };
    await saveSetupState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
    return { batch, repositoryIds: input.repositoryIds };
  });
  await dispatchSetupAutomationRecommendationBatch({
    ...result,
    logContext: 'startSetupAutomationRecommendations',
  });
  return hydrateRecommendationBatch(result.batch)!;
}

export async function dismissSetupAutomationRecommendations() {
  return withRecommendationLock(async (state, tx) => {
    if (!state.automationRecommendations) return null;
    const batch = { ...state.automationRecommendations, dismissed: true };
    await saveSetupState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
    return hydrateRecommendationBatch(batch);
  });
}

async function recordRecommendationLaunch(
  recommendationId: string,
  taskId: string,
) {
  await withRecommendationLock(async (state, tx) => {
    if (!state.automationRecommendations) return;
    const batch = {
      ...state.automationRecommendations,
      recommendations: state.automationRecommendations.recommendations.map(
        (item) =>
          item.id === recommendationId
            ? { ...item, enabled: true, lastRunTaskId: taskId }
            : item,
      ),
    };
    await saveSetupState(
      normalizeSetupNewState({ ...state, automationRecommendations: batch }),
      tx,
    );
  });
}

export async function runSetupAutomationRecommendationNow(input: {
  userId: string;
  id: string;
  runBuiltIn: (
    automationKey: TriggerableBackgroundAutomationKey,
  ) => Promise<AutomationRunNowResult>;
  runCustom: (automationId: string) => Promise<AutomationRunNowResult>;
}) {
  const batch = await listSetupAutomationRecommendations();
  const recommendation = batch?.recommendations.find(
    (item) => item.id === input.id,
  );
  const candidate = recommendation
    ? candidateFor(recommendation.candidateId)
    : null;
  if (!recommendation || !candidate) {
    throw new Error('Recommendation was not found.');
  }
  if (
    candidate.source === 'built_in' &&
    candidate.automationKey === 'review_code'
  ) {
    throw new Error('Review Code runs from pull-request events.');
  }
  let automationId = recommendation.automationId;
  if (!recommendation.enabled) {
    const updated = await setSetupAutomationRecommendationEnabled({
      userId: input.userId,
      id: recommendation.id,
      enabled: true,
    });
    automationId = updated?.automationId ?? null;
  }
  let result: AutomationRunNowResult;
  if (candidate.source === 'cookbook') {
    if (!automationId) {
      throw new Error('Recommendation automation was not created.');
    }
    result = await input.runCustom(automationId);
  } else {
    if (candidate.automationKey === 'review_code') {
      throw new Error('Review Code runs from pull-request events.');
    }
    result = await input.runBuiltIn(candidate.automationKey);
  }
  if (result.outcome === 'launched') {
    await recordRecommendationLaunch(recommendation.id, result.taskId);
  }
  return result;
}
