import type { UserAuthSuccess } from '@/types';
import { deploymentSettings, eq } from '@roomote/db/server';
import { normalizeMetadataRecord } from '@roomote/feature-flags';
import { getSourceControlConnectionSummary } from '@/lib/server/source-control';
import { completeSetupCommand } from './index';
import type { getSetupNewStatusCommand } from '../setup-new';
import { hasSynchronizedSourceControl } from './setup-starter-readiness';

type SetupStatus = Awaited<ReturnType<typeof getSetupNewStatusCommand>>;

export function isConversationalSetupReadyForCompletion(
  status: SetupStatus,
): boolean {
  return (
    status.setupCompletedAt == null &&
    status.modelSetup.setupSatisfied &&
    status.computeSetup.setupSatisfied &&
    (status.optionalSourceControlEnabled ||
      (status.sourceControlSetup.setupSatisfied &&
        hasSynchronizedSourceControl(status)))
  );
}

export async function completeConversationalSetupIfReady(
  auth: UserAuthSuccess,
  status: SetupStatus,
): Promise<boolean> {
  if (!isConversationalSetupReadyForCompletion(status)) return false;

  const result = await completeSetupCommand(auth, undefined, {
    requireIncomplete: true,
    validateBeforeCompletion: async (tx) => {
      const settings = await tx.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { metadata: true },
      });
      if (
        normalizeMetadataRecord(settings?.metadata)
          .optional_source_control_enabled === true
      ) {
        return true;
      }
      // Recheck the rollout switch under the completion lock so disabling it
      // cannot admit repository-free completion from an older status snapshot.
      if (!status.sourceControlSetup.setupSatisfied) return false;
      const sourceControl = await getSourceControlConnectionSummary(tx);
      return Object.values(sourceControl.repositoryCounts).some(
        (repositoryCount) => repositoryCount > 0,
      );
    },
  });
  return result.completionState !== 'not_ready';
}
