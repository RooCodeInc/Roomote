import { db, eq, taskRuns } from '@roomote/db/server';
import type { ComputeProvider } from '@roomote/types';

import type { CredentialEgressLifecycle } from './lifecycle';

type HostedWorkerLaunchResult = { commandId?: string };

/**
 * Plans and completes the credential-egress handoff around one hosted worker
 * launch. Provider-specific launch validation stays in the callback so any
 * failure still reaches the adapter's existing machine cleanup path.
 */
export async function prepareHostedWorkerLaunch(input: {
  credentialEgress?: CredentialEgressLifecycle;
  taskRun: Parameters<CredentialEgressLifecycle['planApiProxy']>[0]['taskRun'];
  provider: ComputeProvider;
}) {
  const plan = await input.credentialEgress?.planApiProxy({
    taskRun: input.taskRun,
    provider: input.provider,
  });

  return async function launchHostedWorker<
    TResult extends HostedWorkerLaunchResult,
  >(
    environment: Record<string, string>,
    launch: (environment: Record<string, string>) => Promise<TResult>,
    admissionSignal?: AbortSignal,
  ): Promise<TResult> {
    const result = await launch({
      ...environment,
      ...plan?.bootstrapEnv,
    });

    if (result.commandId) {
      await db
        .update(taskRuns)
        .set({ sandboxCmdId: result.commandId })
        .where(eq(taskRuns.id, input.taskRun.id));
    }

    // The launched worker is waiting on its bootstrap nonce. Admission errors
    // propagate so the provider adapter applies its normal launch cleanup.
    await plan?.admit(admissionSignal);

    return result;
  };
}
