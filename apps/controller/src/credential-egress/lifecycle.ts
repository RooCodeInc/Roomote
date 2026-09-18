import { randomBytes, randomUUID } from 'node:crypto';

import {
  getComputeProviderCredentialEgressCapability,
  CREDENTIAL_EGRESS_WORKLOAD_ENV,
  TaskPayloadKind,
  type ComputeProvider,
  type CredentialEgressWorkloadRegistration,
  type CredentialEgressWorkloadTerminate,
} from '@roomote/types';
import type { createCredentialEgressControllerClient } from '@roomote/sdk/server/credential-egress';

import { admitCredentialEgressApiProxy } from './api-proxy';

/**
 * Controller-side Session-egress lifecycle.
 *
 * The controller is the only principal that registers, rotates, and
 * terminates workloads. It does so at the moments it already owns: fresh
 * spawn, standby resume (rotation: a new generation invalidates every earlier
 * substitute), and provisioning failure. Terminal run transitions (stop,
 * completion, failure, cancel, standby) terminate the workload inside the
 * centralized run-finalization path, so a workload never outlives its run
 * regardless of which process observed the transition.
 *
 * One admission exists: every supported provider gets substitutes and the
 * API-side proxy base URL, nothing else; the API is the gateway.
 *
 * Fail-closed rules:
 * - a provider whose capability is `unsupported` is never registered;
 * - a run whose Session owner has not enabled integration keys never
 *   registers, matching the gate on the Fast and coding-run tools;
 * - a control-plane error leaves the run without substitutes, never with
 *   partially provisioned ones.
 * In every one of those cases the run gets a nonsecret lifecycle event so the
 * Session shows why no service token is available.
 */

export type CredentialEgressControllerClient = ReturnType<
  typeof createCredentialEgressControllerClient
>;

type CredentialEgressSkipReason =
  | 'disabled'
  | 'unsupported_provider'
  | 'no_grants'
  | 'run_not_eligible';

type CredentialEgressRegistrationOutcome =
  | {
      status: 'registered';
      workload: CredentialEgressWorkloadRegistration;
      /**
       * The control plane still keys active workloads by this identity
       * (`connector_identity`, N-1 column name). Synthetic and unique per
       * generation; never a certificate claim.
       */
      connectorIdentity: string;
    }
  | { status: 'skipped'; reason: CredentialEgressSkipReason }
  | { status: 'failed'; error: string };

const LEASE_SECONDS = 3_600;

/** Unique per registration so a stale generation can never collide with a live one. */
function buildWorkloadIdentity(runId: number): string {
  return `roomote://api-proxy/run/${runId}/${randomBytes(12).toString('hex')}`;
}

export interface CredentialEgressLifecycleEvent {
  runId: number;
  taskId?: string;
  eventType: 'decision' | 'failed' | 'started' | 'completed';
  message: string;
  details: Record<string, string | number | boolean | null>;
}

/**
 * One sandbox launch's share of API-proxy admission. The launcher carries
 * `bootstrapEnv` so the worker pauses after its ordinary bootstrap, and
 * `admit` runs once the worker process is launched: it waits for the
 * bootstrap nonce, registers the run, and publishes the substitute-only
 * configuration. Every hosted provider uses the plan identically; a run that
 * needs no admission gets an empty plan whose `admit` does nothing.
 */
interface CredentialEgressApiProxyPlan {
  required: boolean;
  bootstrapEnv: Record<string, string>;
  admit: (
    signal?: AbortSignal,
  ) => Promise<CredentialEgressWorkloadRegistration | null>;
}

export interface CredentialEgressLifecycleDependencies {
  client: CredentialEgressControllerClient | null;
  /**
   * Base URL sandboxes call the API-side proxy at. Without it admission
   * stays closed: substitutes that cannot be delivered are never minted.
   */
  apiProxyBaseUrl?: string;
  /** Injectable for tests; production admission waits on Redis and the database. */
  admitApiProxy?: typeof admitCredentialEgressApiProxy;
  /** Session/grant preflight; `null` for runs not attached to an owned Session. */
  findCandidate: (runId: number) => Promise<{
    sessionId: string;
    grantCount: number;
    /** The Session owner has integration keys enabled. */
    experimentEnabled: boolean;
  } | null>;
  recordEvent: (event: CredentialEgressLifecycleEvent) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class CredentialEgressLifecycle {
  private readonly renewals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly deps: CredentialEgressLifecycleDependencies) {
    this.logger = deps.logger ?? console;
  }

  /** Whether this deployment can admit the provider through the API proxy. */
  admissionFor(provider: ComputeProvider): 'api_proxy' | null {
    if (!this.deps.client || !this.deps.apiProxyBaseUrl) return null;
    return getComputeProviderCredentialEgressCapability(provider) ===
      'api_proxy'
      ? 'api_proxy'
      : null;
  }

  /** Plan API-proxy admission for one launch; see `CredentialEgressApiProxyPlan`. */
  async planApiProxy(input: {
    taskRun: { id: number; taskId: string; payloadKind: TaskPayloadKind };
    provider: ComputeProvider;
    /**
     * Address the sandbox reaches the API at, when it differs from the
     * deployment default (Docker task networks address the API by alias).
     */
    baseUrl?: string;
  }): Promise<CredentialEgressApiProxyPlan> {
    const { taskRun, provider } = input;
    const baseUrl = input.baseUrl ?? this.deps.apiProxyBaseUrl;
    const required =
      (await this.needsBootstrapAdmission(taskRun.id, provider)) &&
      this.admissionFor(provider) === 'api_proxy';
    if (!required || !baseUrl) {
      return { required: false, bootstrapEnv: {}, admit: async () => null };
    }

    // The sandbox bootstraps with ordinary connectivity and no substitutes;
    // only the controller publishes verified delivery, bound to this nonce,
    // after the worker reports bootstrap done.
    const nonce = randomUUID();
    const admit = this.deps.admitApiProxy ?? admitCredentialEgressApiProxy;
    return {
      required: true,
      bootstrapEnv: {
        [CREDENTIAL_EGRESS_WORKLOAD_ENV.BOOTSTRAP_REQUIRED]: '1',
        [CREDENTIAL_EGRESS_WORKLOAD_ENV.BOOTSTRAP_NONCE]: nonce,
      },
      admit: async (signal) => {
        const workload = await admit({
          lifecycle: this,
          taskRun: { id: taskRun.id, taskId: taskRun.taskId },
          provider,
          nonce,
          baseUrl,
          // A resumed sandbox may still hold an earlier generation's tokens;
          // rotation invalidates them.
          resume: taskRun.payloadKind === TaskPayloadKind.SnapshotResume,
          signal,
        });
        this.logger.log(
          `[credentialEgress] Delivered Service tokens for task run #${taskRun.id} ${JSON.stringify(
            {
              provider,
              workloadId: workload.workloadId,
              generation: workload.generation,
              substituteCount: workload.substitutes.length,
            },
          )}`,
        );
        return workload;
      },
    };
  }

  /** Planning only: do not mint a lease/token while repository bootstrap runs. */
  async needsBootstrapAdmission(
    runId: number,
    provider: ComputeProvider,
  ): Promise<boolean> {
    const candidate = await this.safeFindCandidate(runId);
    if (!candidate || candidate.grantCount === 0) return false;
    if (!candidate.experimentEnabled || !this.admissionFor(provider)) {
      await this.safeRecord({
        runId,
        eventType: 'decision',
        message:
          'Credential egress is unavailable for this run configuration; no substitutes were issued.',
        details: {
          stage: 'credential_egress',
          provider,
          sessionId: candidate.sessionId,
        },
      });
      return false;
    }
    return true;
  }

  /**
   * Register (or rotate) the run's workload. Called on fresh spawn and on
   * resume, once the worker has reported bootstrap and before it receives
   * any substitute.
   */
  async register(input: {
    taskRun: { id: number; taskId: string };
    provider: ComputeProvider;
    resume: boolean;
  }): Promise<CredentialEgressRegistrationOutcome> {
    const { taskRun, provider } = input;
    const candidate = await this.safeFindCandidate(taskRun.id);
    if (!candidate) return { status: 'skipped', reason: 'run_not_eligible' };

    const record = (
      event: Omit<CredentialEgressLifecycleEvent, 'runId' | 'taskId'>,
    ) =>
      this.safeRecord({ runId: taskRun.id, taskId: taskRun.taskId, ...event });

    if (candidate.grantCount === 0) {
      return { status: 'skipped', reason: 'no_grants' };
    }

    if (!candidate.experimentEnabled) {
      await record({
        eventType: 'decision',
        message:
          'Service tokens are unavailable: the Session owner has not enabled integration keys, so no substitute credentials were issued to this run.',
        details: {
          stage: 'credential_egress',
          status: 'disabled',
          provider,
          sessionId: candidate.sessionId,
          grantCount: candidate.grantCount,
        },
      });
      return { status: 'skipped', reason: 'disabled' };
    }

    const capability = getComputeProviderCredentialEgressCapability(provider);
    if (capability === 'unsupported') {
      await record({
        eventType: 'decision',
        message: `Service tokens are unavailable on the ${provider} compute provider: it cannot yet enforce the workload identity and egress contract, so no substitute credentials were issued to this run.`,
        details: {
          stage: 'credential_egress',
          status: 'unsupported_provider',
          provider,
          sessionId: candidate.sessionId,
          grantCount: candidate.grantCount,
        },
      });
      return { status: 'skipped', reason: 'unsupported_provider' };
    }

    if (!this.admissionFor(provider) || !this.deps.client) {
      await record({
        eventType: 'decision',
        message:
          'Service tokens are unavailable: this deployment cannot deliver the Credential egress proxy to this run, so no substitute credentials were issued.',
        details: {
          stage: 'credential_egress',
          status: 'disabled',
          provider,
          sessionId: candidate.sessionId,
          grantCount: candidate.grantCount,
        },
      });
      return { status: 'skipped', reason: 'disabled' };
    }

    const connectorIdentity = buildWorkloadIdentity(taskRun.id);
    let workload: CredentialEgressWorkloadRegistration;
    try {
      workload = await this.deps.client.register({
        runId: taskRun.id,
        provider,
        connectorIdentity,
        leaseSeconds: LEASE_SECONDS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b409\b.*run_not_eligible/.test(message)) {
        return { status: 'skipped', reason: 'run_not_eligible' };
      }
      await record({
        eventType: 'failed',
        message:
          'Service tokens are unavailable for this run: registering the workload with the Credential egress control plane failed, so no substitute credentials were issued.',
        details: {
          stage: 'credential_egress',
          status: 'failed',
          provider,
          sessionId: candidate.sessionId,
          errorClass: error instanceof Error ? error.name : 'Error',
        },
      });
      this.logger.error(
        `[credentialEgress] Workload registration failed for task run #${taskRun.id}: ${sanitizeControlPlaneError(message)}`,
      );
      return { status: 'failed', error: sanitizeControlPlaneError(message) };
    }

    await record({
      eventType: 'decision',
      message: input.resume
        ? `Service tokens were rotated for this resumed run (generation ${workload.generation}); they are usable through the Credential egress API proxy once delivered.`
        : 'Service tokens were prepared for this run; they are usable through the Credential egress API proxy once delivered.',
      details: {
        stage: 'credential_egress',
        status: input.resume ? 'rotated' : 'registered',
        admission: 'api_proxy',
        provider,
        sessionId: workload.sessionId,
        workloadId: workload.workloadId,
        generation: workload.generation,
        leaseExpiresAt: workload.expiresAt,
        substituteCount: workload.substitutes.length,
      },
    });
    return { status: 'registered', workload, connectorIdentity };
  }

  /** Best-effort termination; the run-finalization path is the backstop. */
  async terminate(
    runId: number,
    workloadId: string,
    reason: CredentialEgressWorkloadTerminate['reason'],
  ): Promise<boolean> {
    const timer = this.renewals.get(workloadId);
    if (timer) clearTimeout(timer);
    this.renewals.delete(workloadId);
    if (!this.deps.client) return false;
    try {
      const result = await this.deps.client.terminate(workloadId, { reason });
      return result.terminated;
    } catch (error) {
      this.logger.warn(
        `[credentialEgress] Failed to terminate workload for task run #${runId} (${reason}): ${sanitizeControlPlaneError(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
      return false;
    }
  }

  /** Start only after the controller has verified enforcement and published delivery. */
  startLeaseRenewal(runId: number, workloadId: string): void {
    if (!this.deps.client || this.renewals.has(workloadId)) return;
    const leaseSeconds = LEASE_SECONDS;
    const schedule = () => {
      const timer = setTimeout(
        async () => {
          if (!this.renewals.has(workloadId)) return;
          try {
            await this.deps.client!.renewLease(workloadId, { leaseSeconds });
            if (this.renewals.has(workloadId)) schedule();
          } catch {
            // Live API authorization rejects ended/reattached runs. Outages also
            // stop renewal; the existing lease expires rather than failing open.
            this.renewals.delete(workloadId);
            this.logger.warn(
              `[credentialEgress] Lease renewal stopped for task run #${runId}`,
            );
          }
        },
        Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3)),
      );
      timer.unref();
      this.renewals.set(workloadId, timer);
    };
    schedule();
  }

  private async safeFindCandidate(runId: number) {
    try {
      return await this.deps.findCandidate(runId);
    } catch {
      // Preflight failure must not block an ordinary run; it only means no
      // substitutes this time, which is the fail-closed direction.
      this.logger.warn(
        `[credentialEgress] Candidate lookup failed for task run #${runId}`,
      );
      return null;
    }
  }

  private async safeRecord(
    event: CredentialEgressLifecycleEvent,
  ): Promise<void> {
    try {
      await this.deps.recordEvent(event);
    } catch {
      this.logger.warn(
        `[credentialEgress] Failed to record lifecycle event for task run #${event.runId}`,
      );
    }
  }
}

/** Keep control-plane errors to status + code; never echo payloads. */
function sanitizeControlPlaneError(message: string): string {
  const status = message.slice(0, 100).match(/\b[45][0-9]{2}\b/)?.[0];
  return status
    ? `Control-plane request failed (${status})`
    : 'Control-plane request failed';
}
