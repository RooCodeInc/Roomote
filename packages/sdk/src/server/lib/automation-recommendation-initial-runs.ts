import { db, deploymentSettings, eq, sql } from '@roomote/db/server';
import {
  normalizeSetupNewState,
  type AutomationRecommendationBatch,
} from '@roomote/types';

import { runCustomAutomationNow } from '../automations/custom-automations';
import { runAutomationNow } from '../automations/run-now';
import {
  automationRecommendationInitialRunJobSchema,
  type AutomationRecommendationInitialRunJob,
} from './automation-recommendation-queues';
import { AUTOMATION_RECOMMENDATION_CATALOG } from './automation-recommendations-policy';

const AUTOMATION_RECOMMENDATION_INITIAL_RUN_CLAIM_TIMEOUT_MS = 15 * 60 * 1_000;

function recommendationApplicationState(
  batch: AutomationRecommendationBatch,
): 'pending' | 'applied' | 'skipped' {
  return (
    batch.applicationState ?? (batch.status === 'ready' ? 'applied' : 'pending')
  );
}

export function canRecoverAutomationRecommendationInitialRunClaim(
  recommendation: Pick<
    AutomationRecommendationBatch['recommendations'][number],
    'initialRunClaimedAt' | 'initialRunDispatchAttemptedAt'
  >,
  now = Date.now(),
): boolean {
  if (
    !recommendation.initialRunClaimedAt ||
    recommendation.initialRunDispatchAttemptedAt
  ) {
    return false;
  }

  const claimedAt = Date.parse(recommendation.initialRunClaimedAt);
  return (
    !Number.isFinite(claimedAt) ||
    now - claimedAt >= AUTOMATION_RECOMMENDATION_INITIAL_RUN_CLAIM_TIMEOUT_MS
  );
}

async function claimAutomationRecommendationInitialRun(
  request: AutomationRecommendationInitialRunJob,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const batch = state.automationRecommendations;
    const recommendation = batch?.recommendations.find(
      (item) => item.id === request.recommendationId,
    );
    if (
      !batch ||
      batch.inputFingerprint !== request.fingerprint ||
      recommendationApplicationState(batch) !== 'applied' ||
      !recommendation?.enabled ||
      recommendation.lastRunTaskId ||
      recommendation.initialRunTerminalAt
    ) {
      return null;
    }

    if (
      recommendation.initialRunClaimedAt &&
      !canRecoverAutomationRecommendationInitialRunClaim(recommendation)
    ) {
      return null;
    }

    const claimedAt = new Date().toISOString();
    const nextBatch = {
      ...batch,
      recommendations: batch.recommendations.map((item) =>
        item.id === request.recommendationId
          ? {
              ...item,
              initialRunClaimedAt: claimedAt,
              initialRunDispatchAttemptedAt: null,
            }
          : item,
      ),
    };
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: normalizeSetupNewState({
          ...state,
          automationRecommendations: nextBatch,
        }),
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));

    return {
      claimedAt,
      candidateId: recommendation.candidateId,
      automationId: recommendation.automationId,
    };
  });
}

async function markAutomationRecommendationInitialRunDispatchAttempted(
  request: AutomationRecommendationInitialRunJob,
  claimedAt: string,
): Promise<boolean> {
  let dispatchMarked = false;
  await updateAutomationRecommendationInitialRun(request, (item) => {
    if (
      item.initialRunClaimedAt !== claimedAt ||
      item.initialRunDispatchAttemptedAt ||
      item.initialRunTerminalAt
    ) {
      return item;
    }

    dispatchMarked = true;
    return {
      ...item,
      initialRunDispatchAttemptedAt: new Date().toISOString(),
    };
  });
  return dispatchMarked;
}

async function updateAutomationRecommendationInitialRun(
  request: AutomationRecommendationInitialRunJob,
  update: (
    recommendation: AutomationRecommendationBatch['recommendations'][number],
  ) => AutomationRecommendationBatch['recommendations'][number],
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('automation-recommendations'))`,
    );
    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const batch = state.automationRecommendations;
    if (!batch || batch.inputFingerprint !== request.fingerprint) return;
    const nextBatch = {
      ...batch,
      recommendations: batch.recommendations.map((item) =>
        item.id === request.recommendationId ? update(item) : item,
      ),
    };
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: normalizeSetupNewState({
          ...state,
          automationRecommendations: nextBatch,
        }),
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
  });
}

export async function runAutomationRecommendationInitialRunJob(
  input: AutomationRecommendationInitialRunJob,
): Promise<void> {
  const request = automationRecommendationInitialRunJobSchema.parse(input);
  const claimed = await claimAutomationRecommendationInitialRun(request);
  if (!claimed) return;

  const candidate = AUTOMATION_RECOMMENDATION_CATALOG.find(
    (item) => item.id === claimed.candidateId,
  );
  if (!candidate) {
    await updateAutomationRecommendationInitialRun(request, (item) => ({
      ...item,
      initialRunClaimedAt: null,
      initialRunDispatchAttemptedAt: null,
    }));
    throw new Error(
      `Recommendation candidate was not found: ${claimed.candidateId}`,
    );
  }

  let launched = false;
  try {
    const dispatchMarked =
      await markAutomationRecommendationInitialRunDispatchAttempted(
        request,
        claimed.claimedAt,
      );
    if (!dispatchMarked) return;

    const result =
      candidate.source === 'built_in'
        ? candidate.automationKey === 'review_code'
          ? {
              outcome: 'skipped' as const,
              reason: 'Review Code runs from pull-request events.',
            }
          : await runAutomationNow(candidate.automationKey)
        : claimed.automationId
          ? await runCustomAutomationNow(claimed.automationId)
          : {
              outcome: 'failed' as const,
              error: 'Recommendation automation was not created.',
            };

    if (result.outcome === 'failed') {
      throw new Error(result.error);
    }

    launched = result.outcome === 'launched';
    await updateAutomationRecommendationInitialRun(request, (item) => ({
      ...item,
      initialRunClaimedAt: null,
      initialRunDispatchAttemptedAt: null,
      initialRunTerminalAt: new Date().toISOString(),
      ...(result.outcome === 'launched'
        ? { lastRunTaskId: result.taskId }
        : {}),
    }));
  } catch (error) {
    if (launched) {
      try {
        await updateAutomationRecommendationInitialRun(request, (item) => ({
          ...item,
          initialRunClaimedAt: null,
          initialRunDispatchAttemptedAt: null,
          initialRunTerminalAt: new Date().toISOString(),
        }));
      } catch (terminalError) {
        console.error(
          `[automation-recommendations] Initial run launched for ${request.recommendationId}, but recording its terminal state failed:`,
          terminalError,
        );
      }
      return;
    }
    await updateAutomationRecommendationInitialRun(request, (item) => ({
      ...item,
      initialRunClaimedAt: null,
      initialRunDispatchAttemptedAt: null,
    }));
    throw error;
  }
}
