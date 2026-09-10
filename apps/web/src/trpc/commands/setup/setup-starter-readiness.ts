import { normalizeSetupNewSetupSession } from '@roomote/types';
import type { getSetupNewStatusCommand } from '../setup-new';

type SetupStatus = Awaited<ReturnType<typeof getSetupNewStatusCommand>>;

export function hasSynchronizedSourceControl(status: SetupStatus): boolean {
  return status.sourceControlSetup.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );
}

export function assertSetupStarterWorkReady(
  status: SetupStatus,
  options: { requireStarterSelection?: boolean; requireCompute?: boolean } = {},
): void {
  if (!hasSynchronizedSourceControl(status)) {
    throw new Error(
      'Connect source control and sync at least one repository before choosing or starting work.',
    );
  }

  const setupSession = normalizeSetupNewSetupSession(
    status.setupNewState.setupSession,
  );
  if (options.requireStarterSelection && !setupSession?.starterTaskSelection) {
    throw new Error('Choose your first work before starting a task.');
  }
  if (options.requireCompute && !status.computeSetup.setupSatisfied) {
    throw new Error('Set up a sandbox before starting work.');
  }
}
