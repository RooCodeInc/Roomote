import { readFileSync } from 'node:fs';

import {
  getComputeProviderSessionEgressCapability,
  type ComputeProvider,
  type SessionEgressWorkloadRegistration,
  type SessionEgressWorkloadTerminate,
} from '@roomote/types';
import type { createSessionEgressControllerClient } from '@roomote/sdk/server/session-egress';

import {
  buildConnectorIdentity,
  issueConnectorCertificate,
  loadConnectorCertificateAuthority,
  type ConnectorCertificateAuthority,
  type IssuedConnectorCertificate,
} from './connector-certificate';

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
 * Fail-closed rules:
 * - a provider whose capability is not `enforced` is never registered;
 * - a deployment without gateway/CA configuration never registers;
 * - a control-plane error leaves the run without substitutes, never with
 *   partially provisioned ones.
 * In every one of those cases the run gets a nonsecret lifecycle event so the
 * Session shows why no service token is available.
 */

export type SessionEgressControllerClient = ReturnType<
  typeof createSessionEgressControllerClient
>;

/** Setup is untrusted; only a successful infrastructure verification permits delivery. */
export async function admitBootstrappedSessionEgress(steps: {
  waitForBootstrap: () => Promise<void>;
  enforceAndVerify: () => Promise<void>;
  deliver: () => Promise<void>;
}): Promise<void> {
  await steps.waitForBootstrap();
  await steps.enforceAndVerify();
  await steps.deliver();
}

export interface SessionEgressProvisioningConfig {
  /** `host:port` the connector sidecar dials with mTLS. */
  gatewayAddr: string;
  /** PUBLIC gateway MITM CA, the only certificate material a workload receives. */
  gatewayCaCertificatePem: string;
  /** Optional roots the connector uses to verify the gateway's outer TLS. */
  gatewayServerCaPem?: string;
  /** Controller-held CA that signs connector client certificates. */
  connectorCa: ConnectorCertificateAuthority;
  connectorImage: string;
  /** Optional extra Docker network the connector joins to reach the gateway. */
  gatewayNetwork?: string;
  leaseSeconds: number;
}

interface SessionEgressEnvLike {
  SESSION_EGRESS_GATEWAY_ADDR?: string;
  SESSION_EGRESS_GATEWAY_CA_CERT_FILE?: string;
  SESSION_EGRESS_GATEWAY_SERVER_CA_FILE?: string;
  SESSION_EGRESS_CONNECTOR_CA_CERT_FILE?: string;
  SESSION_EGRESS_CONNECTOR_CA_KEY_FILE?: string;
  SESSION_EGRESS_CONNECTOR_IMAGE?: string;
  SESSION_EGRESS_GATEWAY_NETWORK?: string;
  SESSION_EGRESS_WORKLOAD_LEASE_SECONDS?: number;
}

/**
 * `null` means the deployment has not configured Session egress; every run
 * is then reported as `disabled`. A partially configured deployment is a
 * startup error rather than a silent disable.
 */
export function resolveSessionEgressProvisioningConfig(
  env: SessionEgressEnvLike,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SessionEgressProvisioningConfig | null {
  const required = {
    SESSION_EGRESS_GATEWAY_ADDR: env.SESSION_EGRESS_GATEWAY_ADDR,
    SESSION_EGRESS_GATEWAY_CA_CERT_FILE:
      env.SESSION_EGRESS_GATEWAY_CA_CERT_FILE,
    SESSION_EGRESS_CONNECTOR_CA_CERT_FILE:
      env.SESSION_EGRESS_CONNECTOR_CA_CERT_FILE,
    SESSION_EGRESS_CONNECTOR_CA_KEY_FILE:
      env.SESSION_EGRESS_CONNECTOR_CA_KEY_FILE,
  };
  const present = Object.entries(required).filter(([, value]) =>
    Boolean(value?.trim()),
  );
  if (present.length === 0) return null;
  if (present.length !== Object.keys(required).length) {
    const missing = Object.entries(required)
      .filter(([, value]) => !value?.trim())
      .map(([key]) => key);
    throw new Error(
      `Session egress is partially configured; set ${missing.join(', ')} or unset every SESSION_EGRESS_* value`,
    );
  }

  const gatewayAddr = required.SESSION_EGRESS_GATEWAY_ADDR!.trim();
  if (!/^[^\s/:]+:\d{1,5}$/.test(gatewayAddr)) {
    throw new Error(
      'SESSION_EGRESS_GATEWAY_ADDR must be host:port (no scheme or path)',
    );
  }

  return {
    gatewayAddr,
    gatewayCaCertificatePem: readFile(
      required.SESSION_EGRESS_GATEWAY_CA_CERT_FILE!,
    ),
    gatewayServerCaPem: env.SESSION_EGRESS_GATEWAY_SERVER_CA_FILE?.trim()
      ? readFile(env.SESSION_EGRESS_GATEWAY_SERVER_CA_FILE.trim())
      : undefined,
    connectorCa: loadConnectorCertificateAuthority(
      {
        certificateFile: required.SESSION_EGRESS_CONNECTOR_CA_CERT_FILE!,
        privateKeyFile: required.SESSION_EGRESS_CONNECTOR_CA_KEY_FILE!,
      },
      readFile,
    ),
    connectorImage:
      env.SESSION_EGRESS_CONNECTOR_IMAGE?.trim() ||
      'roomote/session-egress-gateway',
    gatewayNetwork: env.SESSION_EGRESS_GATEWAY_NETWORK?.trim() || undefined,
    leaseSeconds: env.SESSION_EGRESS_WORKLOAD_LEASE_SECONDS ?? 3_600,
  };
}

export type SessionEgressSkipReason =
  | 'disabled'
  | 'unsupported_provider'
  | 'no_grants'
  | 'run_not_eligible';

export type SessionEgressRegistrationOutcome =
  | {
      status: 'registered';
      workload: SessionEgressWorkloadRegistration;
      connectorIdentity: string;
      connector: IssuedConnectorCertificate;
    }
  | { status: 'skipped'; reason: SessionEgressSkipReason }
  | { status: 'failed'; error: string };

export interface SessionEgressLifecycleEvent {
  runId: number;
  taskId?: string;
  eventType: 'decision' | 'failed' | 'started' | 'completed';
  message: string;
  details: Record<string, string | number | boolean | null>;
}

export interface SessionEgressLifecycleDependencies {
  client: SessionEgressControllerClient | null;
  config: SessionEgressProvisioningConfig | null;
  /** Session/grant preflight; `null` for runs not attached to an owned Session. */
  findCandidate: (
    runId: number,
  ) => Promise<{ sessionId: string; grantCount: number } | null>;
  recordEvent: (event: SessionEgressLifecycleEvent) => Promise<void>;
  issueCertificate?: typeof issueConnectorCertificate;
  connectorIdentityFor?: (runId: number) => string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class SessionEgressLifecycle {
  private readonly renewals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly issueCertificate: typeof issueConnectorCertificate;
  private readonly connectorIdentityFor: (runId: number) => string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly deps: SessionEgressLifecycleDependencies) {
    this.issueCertificate = deps.issueCertificate ?? issueConnectorCertificate;
    this.connectorIdentityFor =
      deps.connectorIdentityFor ?? buildConnectorIdentity;
    this.logger = deps.logger ?? console;
  }

  get config(): SessionEgressProvisioningConfig | null {
    return this.deps.config;
  }

  /** Planning only: do not mint a lease/token while repository bootstrap runs. */
  async needsBootstrapAdmission(
    runId: number,
    provider: ComputeProvider,
  ): Promise<boolean> {
    const candidate = await this.safeFindCandidate(runId);
    if (!candidate || candidate.grantCount === 0) return false;
    if (
      getComputeProviderSessionEgressCapability(provider) !== 'enforced' ||
      !this.deps.config ||
      !this.deps.client
    ) {
      await this.safeRecord({
        runId,
        eventType: 'decision',
        message:
          'Session egress is unavailable for this run configuration; no substitutes were issued.',
        details: {
          stage: 'session_egress',
          provider,
          sessionId: candidate.sessionId,
        },
      });
      return false;
    }
    return true;
  }

  /**
   * Register (or rotate) the run's workload and mint its connector
   * certificate. Called on fresh spawn and on standby resume, after the
   * provider's isolated network exists and before the worker gets any env.
   */
  async register(input: {
    taskRun: { id: number; taskId: string };
    provider: ComputeProvider;
    resume: boolean;
  }): Promise<SessionEgressRegistrationOutcome> {
    const { taskRun, provider } = input;
    const candidate = await this.safeFindCandidate(taskRun.id);
    if (!candidate) return { status: 'skipped', reason: 'run_not_eligible' };

    const record = (
      event: Omit<SessionEgressLifecycleEvent, 'runId' | 'taskId'>,
    ) =>
      this.safeRecord({ runId: taskRun.id, taskId: taskRun.taskId, ...event });

    if (candidate.grantCount === 0) {
      return { status: 'skipped', reason: 'no_grants' };
    }

    if (getComputeProviderSessionEgressCapability(provider) !== 'enforced') {
      await record({
        eventType: 'decision',
        message: `Session service tokens are unavailable on the ${provider} compute provider: it cannot yet enforce the workload identity and egress contract, so no substitute credentials were issued to this run.`,
        details: {
          stage: 'session_egress',
          status: 'unsupported_provider',
          provider,
          sessionId: candidate.sessionId,
          grantCount: candidate.grantCount,
        },
      });
      return { status: 'skipped', reason: 'unsupported_provider' };
    }

    if (!this.deps.config || !this.deps.client) {
      await record({
        eventType: 'decision',
        message:
          'Session service tokens are unavailable: this deployment has no Session egress gateway configured, so no substitute credentials were issued to this run.',
        details: {
          stage: 'session_egress',
          status: 'disabled',
          provider,
          sessionId: candidate.sessionId,
          grantCount: candidate.grantCount,
        },
      });
      return { status: 'skipped', reason: 'disabled' };
    }

    const connectorIdentity = this.connectorIdentityFor(taskRun.id);
    let workload: SessionEgressWorkloadRegistration;
    try {
      workload = await this.deps.client.register({
        runId: taskRun.id,
        provider,
        connectorIdentity,
        leaseSeconds: this.deps.config.leaseSeconds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b409\b.*run_not_eligible/.test(message)) {
        return { status: 'skipped', reason: 'run_not_eligible' };
      }
      await record({
        eventType: 'failed',
        message:
          'Session service tokens are unavailable for this run: registering the workload with the Session egress control plane failed, so no substitute credentials were issued.',
        details: {
          stage: 'session_egress',
          status: 'failed',
          provider,
          sessionId: candidate.sessionId,
          errorClass: error instanceof Error ? error.name : 'Error',
        },
      });
      this.logger.error(
        `[sessionEgress] Workload registration failed for task run #${taskRun.id}: ${sanitizeControlPlaneError(message)}`,
      );
      return { status: 'failed', error: sanitizeControlPlaneError(message) };
    }

    let connector: IssuedConnectorCertificate;
    try {
      connector = this.issueCertificate(this.deps.config.connectorCa, {
        connectorIdentity,
        workloadId: workload.workloadId,
        // Outlive the lease slightly so a renewed lease is not cut short by
        // the certificate; rotation re-issues on resume anyway.
        validitySeconds: Math.max(
          86_400,
          this.deps.config.leaseSeconds + 15 * 60,
        ),
      });
    } catch {
      // No connector can exist for this generation: retire it immediately.
      await this.terminate(taskRun.id, workload.workloadId, 'provision_failed');
      await record({
        eventType: 'failed',
        message:
          'Session service tokens are unavailable for this run: issuing the connector certificate failed, so the workload was retired before any substitute credential was delivered.',
        details: {
          stage: 'session_egress',
          status: 'failed',
          provider,
          sessionId: candidate.sessionId,
          workloadId: workload.workloadId,
        },
      });
      return {
        status: 'failed',
        error: 'Session egress connector certificate could not be issued',
      };
    }

    await record({
      eventType: 'decision',
      message: input.resume
        ? `Session service tokens were rotated for this resumed run (generation ${workload.generation}); external connector provisioning is still required.`
        : `Session service tokens were prepared for this run; external connector provisioning is still required.`,
      details: {
        stage: 'session_egress',
        status: input.resume ? 'rotated' : 'registered',
        provider,
        sessionId: workload.sessionId,
        workloadId: workload.workloadId,
        generation: workload.generation,
        leaseExpiresAt: workload.expiresAt,
        substituteCount: workload.substitutes.length,
        connectorCertificateExpiresAt: connector.notAfter.toISOString(),
      },
    });

    return { status: 'registered', workload, connectorIdentity, connector };
  }

  /** Best-effort termination; the run-finalization path is the backstop. */
  async terminate(
    runId: number,
    workloadId: string,
    reason: SessionEgressWorkloadTerminate['reason'],
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
        `[sessionEgress] Failed to terminate workload for task run #${runId} (${reason}): ${sanitizeControlPlaneError(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
      return false;
    }
  }

  /** Start only after the controller has verified enforcement and published delivery. */
  startLeaseRenewal(runId: number, workloadId: string): void {
    if (!this.deps.config || !this.deps.client || this.renewals.has(workloadId))
      return;
    const leaseSeconds = this.deps.config.leaseSeconds;
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
              `[sessionEgress] Lease renewal stopped for task run #${runId}`,
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
        `[sessionEgress] Candidate lookup failed for task run #${runId}`,
      );
      return null;
    }
  }

  private async safeRecord(event: SessionEgressLifecycleEvent): Promise<void> {
    try {
      await this.deps.recordEvent(event);
    } catch {
      this.logger.warn(
        `[sessionEgress] Failed to record lifecycle event for task run #${event.runId}`,
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
