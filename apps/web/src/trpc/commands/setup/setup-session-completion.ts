import type { UserAuthSuccess } from '@/types';
import { getSourceControlConnectionSummary } from '@/lib/server/source-control';
import { deploymentSettings, eq } from '@roomote/db/server';
import {
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
  type SetupStarterTaskId,
} from '@roomote/types';
import { completeSetupCommand } from './index';
import type { getSetupNewStatusCommand } from '../setup-new';

type SetupStatus = Awaited<ReturnType<typeof getSetupNewStatusCommand>>;

export function isConversationalSetupReadyForCompletion(
  status: SetupStatus,
  attemptedStarterTaskIds: readonly SetupStarterTaskId[] = [],
): boolean {
  const setupSession = normalizeSetupNewSetupSession(
    status.setupNewState.setupSession,
  );
  const hasSynchronizedRepository = status.sourceControlSetup.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );
  return isSetupProgressReady({
    setupCompleted: status.setupCompletedAt != null,
    modelReady: status.modelSetup.setupSatisfied,
    computeReady: status.computeSetup.setupSatisfied,
    hasSynchronizedRepository,
    setupSession,
    attemptedStarterTaskIds,
  });
}

export async function completeConversationalSetupIfReady(
  auth: UserAuthSuccess,
  status: SetupStatus,
  attemptedStarterTaskIds: readonly SetupStarterTaskId[] = [],
): Promise<boolean> {
  if (!isConversationalSetupReadyForCompletion(status, attemptedStarterTaskIds))
    return false;

  const result = await completeSetupCommand(auth, undefined, {
    requireIncomplete: true,
    validateBeforeCompletion: async (tx) => {
      const [settings] = await tx
        .select({ setupNewState: deploymentSettings.setupNewState })
        .from(deploymentSettings)
        .where(eq(deploymentSettings.id, 'default'))
        .limit(1);
      const state = normalizeSetupNewState(settings?.setupNewState ?? {});
      const sourceControl = await getSourceControlConnectionSummary(tx);
      const hasSynchronizedRepository = Object.values(
        sourceControl.repositoryCounts,
      ).some((repositoryCount) => repositoryCount > 0);
      return isSetupProgressReady({
        setupCompleted: false,
        modelReady: status.modelSetup.setupSatisfied,
        computeReady: status.computeSetup.setupSatisfied,
        hasSynchronizedRepository,
        setupSession: normalizeSetupNewSetupSession(state.setupSession),
        attemptedStarterTaskIds,
      });
    },
  });
  return result.completionState !== 'not_ready';
}

function isSetupProgressReady(input: {
  setupCompleted: boolean;
  modelReady: boolean;
  computeReady: boolean;
  hasSynchronizedRepository: boolean;
  setupSession: ReturnType<typeof normalizeSetupNewSetupSession>;
  attemptedStarterTaskIds: readonly SetupStarterTaskId[];
}): boolean {
  if (input.setupCompleted || !input.modelReady || !input.setupSession) {
    return false;
  }
  // Missing discovery state belongs to sessions created before discovery and
  // remains complete for backward compatibility.
  if (input.setupSession.integrationDiscoveryCompletedAt === null) return false;

  if (!input.hasSynchronizedRepository) {
    return Boolean(input.setupSession.sourceControlSkippedAt);
  }

  const selection = input.setupSession.starterTaskSelection;
  if (!selection) return false;
  if (selection.taskIds.length === 0) return true;
  if (!input.computeReady) return false;

  const attempted = new Set(input.attemptedStarterTaskIds);
  return selection.taskIds.every((taskId) => attempted.has(taskId));
}
