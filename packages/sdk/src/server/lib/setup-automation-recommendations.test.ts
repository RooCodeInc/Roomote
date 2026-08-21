import {
  createEmptySetupNewState,
  type AutomationRecommendationBatch,
} from '@roomote/types';
import { db, deploymentSettings, eq } from '@roomote/db/server';

import {
  createPendingAutomationRecommendationBatch,
  listSetupAutomationRecommendations,
  skipSetupAutomationRecommendations,
  updateSetupAutomationRecommendationBatchIfCurrent,
} from './setup-automation-recommendations';

const recommendation = {
  id: 'built-in.ci-failure-triage:1',
  candidateId: 'built-in.ci-failure-triage',
  rank: 1,
  score: 1,
  explanation: 'Fix broken builds.',
  enabled: true,
  lastRunTaskId: null,
  automationId: null,
};

function batch(): AutomationRecommendationBatch {
  return {
    version: 1,
    inputFingerprint: 'recommendation-fingerprint',
    catalogVersion: 1,
    status: 'ready',
    startedAt: '2026-08-14T00:00:00.000Z',
    completedAt: '2026-08-14T00:00:01.000Z',
    partial: false,
    errorCode: null,
    dismissed: false,
    applicationState: 'pending',
    recommendations: [recommendation],
  };
}

describe('setup automation recommendation state', () => {
  let originalSetupNewState: (typeof deploymentSettings.$inferSelect)['setupNewState'];
  let hadSettings = false;

  beforeAll(async () => {
    const [settings] = await db
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    hadSettings = settings !== undefined;
    originalSetupNewState = settings?.setupNewState ?? null;
  });

  afterAll(async () => {
    if (!hadSettings) {
      await db
        .delete(deploymentSettings)
        .where(eq(deploymentSettings.id, 'default'));
      return;
    }
    await db
      .update(deploymentSettings)
      .set({ setupNewState: originalSetupNewState })
      .where(eq(deploymentSettings.id, 'default'));
  });

  beforeEach(async () => {
    await db
      .insert(deploymentSettings)
      .values({
        id: 'default',
        setupNewState: {
          ...createEmptySetupNewState(),
          automationRecommendations: batch(),
        },
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          setupNewState: {
            ...createEmptySetupNewState(),
            automationRecommendations: batch(),
          },
        },
      });
  });

  it('hydrates client-safe titles for batches persisted before titles existed', async () => {
    const result = await listSetupAutomationRecommendations();

    expect(result?.recommendations[0]).toMatchObject({
      candidateId: 'built-in.ci-failure-triage',
      title: 'CI Failure Triage',
    });
  });

  it('persists skipped recommendations as disabled and unapplied', async () => {
    await skipSetupAutomationRecommendations();

    const [settings] = await db
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    expect(settings?.setupNewState?.automationRecommendations).toMatchObject({
      applicationState: 'skipped',
      recommendations: [
        expect.objectContaining({ enabled: false, applied: false }),
      ],
    });
  });

  it('preserves same-input choices while resetting generation state', () => {
    const previous = { ...batch(), dismissed: true };

    expect(
      createPendingAutomationRecommendationBatch(
        previous.inputFingerprint,
        previous,
      ),
    ).toMatchObject({
      status: 'pending',
      dismissed: true,
      recommendations: previous.recommendations,
    });
  });

  it('rejects stale worker writes after the recommendation input changes', async () => {
    const result = await updateSetupAutomationRecommendationBatchIfCurrent(
      'stale-fingerprint',
      (current) => ({ ...current, status: 'failed' }),
    );

    expect(result).toBeNull();
    expect(await listSetupAutomationRecommendations()).toMatchObject({
      inputFingerprint: 'recommendation-fingerprint',
      status: 'ready',
    });
  });
});
