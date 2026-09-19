import { setTimeout as delay } from 'node:timers/promises';

import { db, eq, taskRuns } from '@roomote/db/server';
import {
  isCredentialEgressBootstrapReady,
  publishCredentialEgressDelivery,
} from '@roomote/sdk/server';
import {
  activeRunStatuses,
  buildCredentialEgressServiceTokenEnv,
  credentialEgressProxyBaseUrl,
  CREDENTIAL_EGRESS_WORKLOAD_ENV,
  type ComputeProvider,
  type CredentialEgressWorkloadRegistration,
} from '@roomote/types';

import type { CredentialEgressLifecycle } from './lifecycle';

/**
 * API-proxy admission, shared by every supported compute provider.
 *
 * The provider spawns the sandbox normally with a bootstrap nonce. The worker
 * runs its ordinary setup, marks the nonce ready, and waits. The controller
 * then registers the run (minting substitutes), publishes the substitute-only
 * client configuration bound to that nonce, and starts lease renewal. There
 * is nothing to enforce or verify on the network: the API proxy authenticates
 * each request against live state, so delivery is the only step.
 */

/** Bounds the wait for a worker that never finishes bootstrap. */
const BOOTSTRAP_ADMISSION_DEADLINE_MS = 20 * 60_000;
const BOOTSTRAP_POLL_MS = 500;

export class CredentialEgressBootstrapRunInactiveError extends Error {
  constructor() {
    super('Credential egress bootstrap run is no longer active');
    this.name = 'CredentialEgressBootstrapRunInactiveError';
  }
}

/** Base URL every approved service is called through from this deployment's sandboxes. */
export function resolveCredentialEgressApiProxyBaseUrl(env: {
  TRPC_URL: string;
  R_CREDENTIAL_EGRESS_PROXY_HOST?: string;
}): string {
  return credentialEgressProxyBaseUrl(
    env.TRPC_URL,
    env.R_CREDENTIAL_EGRESS_PROXY_HOST,
  );
}

/** Worker launcher env: the base URL, the nonsecret manifest, and substitutes only. */
export function buildCredentialEgressApiProxyWorkerEnv(params: {
  registration: CredentialEgressWorkloadRegistration;
  baseUrl: string;
}): Record<string, string> {
  const { tokens, manifest } = buildCredentialEgressServiceTokenEnv(
    params.registration.substitutes,
    { baseUrl: params.baseUrl },
  );
  return {
    [CREDENTIAL_EGRESS_WORKLOAD_ENV.BASE_URL]: params.baseUrl,
    [CREDENTIAL_EGRESS_WORKLOAD_ENV.SERVICES]: JSON.stringify(manifest),
    ...tokens,
  };
}

export interface ApiProxyAdmissionDependencies {
  isBootstrapReady: (runId: number, nonce: string) => Promise<boolean>;
  isRunActive: (runId: number) => Promise<boolean>;
  publish: (
    runId: number,
    registration: CredentialEgressWorkloadRegistration,
    environment: Record<string, string>,
    nonce: string,
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// Resolved per call, not at module load: callers that mock the SDK or the
// database (controller unit tests) must be able to import this module.
function productionDependencies(): ApiProxyAdmissionDependencies {
  return {
    isBootstrapReady: (runId, nonce) =>
      isCredentialEgressBootstrapReady(runId, nonce),
    isRunActive: async (runId) => {
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, runId),
        columns: { status: true },
      });
      return Boolean(
        run && activeRunStatuses.some((status) => status === run.status),
      );
    },
    publish: (runId, registration, environment, nonce) =>
      publishCredentialEgressDelivery(runId, registration, environment, nonce),
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
  };
}

/**
 * Run after the worker process is launched. Returns the registration once the
 * substitute-only configuration is published; throws if the run stopped, the
 * worker never reported bootstrap, registration was refused, or delivery
 * failed. Any workload minted along the way is retired before throwing.
 */
export async function admitCredentialEgressApiProxy(
  input: {
    lifecycle: CredentialEgressLifecycle;
    taskRun: { id: number; taskId: string };
    provider: ComputeProvider;
    nonce: string;
    baseUrl: string;
    resume?: boolean;
    signal?: AbortSignal;
  },
  deps: ApiProxyAdmissionDependencies = productionDependencies(),
): Promise<CredentialEgressWorkloadRegistration> {
  const deadline = deps.now() + BOOTSTRAP_ADMISSION_DEADLINE_MS;
  // Setup completion is a request to transition, never authority: the run
  // must still be live when the controller registers it.
  for (;;) {
    if (input.signal?.aborted) {
      throw new Error('Credential egress bootstrap admission aborted');
    }
    if (!(await deps.isRunActive(input.taskRun.id)))
      throw new CredentialEgressBootstrapRunInactiveError();
    if (await deps.isBootstrapReady(input.taskRun.id, input.nonce)) break;
    if (deps.now() >= deadline)
      throw new Error('Credential egress bootstrap admission timed out');
    await deps.sleep(BOOTSTRAP_POLL_MS);
  }

  if (input.signal?.aborted) {
    throw new Error('Credential egress bootstrap admission aborted');
  }

  const outcome = await input.lifecycle.register({
    taskRun: input.taskRun,
    provider: input.provider,
    resume: input.resume ?? false,
  });
  if (outcome.status !== 'registered')
    throw new Error('Credential egress admission is no longer eligible');

  try {
    await deps.publish(
      input.taskRun.id,
      outcome.workload,
      buildCredentialEgressApiProxyWorkerEnv({
        registration: outcome.workload,
        baseUrl: input.baseUrl,
      }),
      input.nonce,
    );
  } catch (error) {
    // Undelivered substitutes must not stay live.
    await input.lifecycle.terminate(
      input.taskRun.id,
      outcome.workload.workloadId,
      'provision_failed',
    );
    throw error;
  }
  input.lifecycle.startLeaseRenewal(
    input.taskRun.id,
    outcome.workload.workloadId,
  );
  return outcome.workload;
}
