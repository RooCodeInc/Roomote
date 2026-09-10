import type { UserAuthSuccess } from '@/types';
import { getSourceControlConnectionSummary } from '@/lib/server/source-control';
import { completeSetupCommand } from './index';
import type { getSetupNewStatusCommand } from '../setup-new';

type SetupStatus = Awaited<ReturnType<typeof getSetupNewStatusCommand>>;

export function isConversationalSetupReadyForCompletion(
  status: SetupStatus,
): boolean {
  return (
    status.setupCompletedAt == null &&
    status.modelSetup.setupSatisfied &&
    status.computeSetup.setupSatisfied &&
    status.sourceControlSetup.setupSatisfied &&
    status.sourceControlSetup.providers.some(
      (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
    )
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
      const sourceControl = await getSourceControlConnectionSummary(tx);
      return Object.values(sourceControl.repositoryCounts).some(
        (repositoryCount) => repositoryCount > 0,
      );
    },
  });
  return result.completionState !== 'not_ready';
}
