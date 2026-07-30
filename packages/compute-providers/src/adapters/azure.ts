import { randomUUID } from 'node:crypto';

import {
  AZURE_CAPABILITIES as AZURE_CAPABILITIES_VALUE,
  type ComputeProvider,
} from '@roomote/types';

import { raceWithAbort, sleepWithSignal, throwIfAborted } from '../modal/abort';
import {
  acquireAzureToken,
  createAzureCredential,
  type AzureTokenCredential,
} from '../azure/credentials';
import type {
  AzureConfig,
  CommandOutputEvent,
  ComputeProviderCapabilities,
  ComputeProviderClient,
  ComputeInstanceStatus,
  CreateInstanceInput,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreatedInstance,
  DestroyInstanceInput,
  DestroyInstanceResult,
  EnterStandbyInput,
  EnterStandbyResult,
  FindSnapshotBySourceInstanceInput,
  GetCommandOutputInput,
  GetInstanceDomainsInput,
  GetInstanceDomainsResult,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeFromStandbyInput,
  ResumeInstanceInput,
  RunCommandInput,
  RunCommandResult,
  SourceInstanceSnapshot,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';

const API_VERSION = '2026-02-01-preview';
const DATA_PLANE_SCOPE = 'https://dynamicsessions.io/.default';

const DEFAULT_CPU_MILLICORES = 1000;
const DEFAULT_MEMORY_MIB = 2048;

const RUNNING_POLL_INTERVAL_MS = 1_000;
const RUNNING_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const STREAM_POLL_INTERVAL_MS = 1_000;
const DETACHED_START_GRACE_MS = 1_500;
const DETACHED_EXIT_POLL_INTERVAL_MS = 2_000;
const DETACHED_EXIT_POLL_MAX_MS = 12 * 60 * 60 * 1_000;

const RETRY_MAX_ATTEMPTS = 8;
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;

const HTTP_DEBUG =
  process.env.AZURE_HTTP_DEBUG === '1' ||
  process.env.AZURE_HTTP_DEBUG === 'true';

function logHttp(message: string, fields: Record<string, unknown>): void {
  if (HTTP_DEBUG) {
    console.log(`[AzureClient:http] ${message} ${JSON.stringify(fields)}`);
  }
}

/**
 * Root for detached-command state inside the sandbox. Mirrors the shared
 * `/sandbox` worker layout; logs + exit sentinels for detached commands live
 * here because ACA exec is one-shot (no sessions API), with a 1 MiB output
 * cap and a ~60s wall-clock limit (measured 2026-07-28).
 */
const DETACHED_LOG_ROOT = '/sandbox/.roomote/logs';

const IDEMPOTENCY_LABEL = 'roomote-idempotency-key';
const PRODUCT_SNAPSHOT_NAME_PREFIX = 'roomote-task';

interface AzureSandbox {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  lifecycle?: {
    autoSuspendPolicy?: { enabled?: boolean; interval?: number; mode?: string };
    autoDeletePolicy?: { enabled?: boolean; deleteIntervalInSeconds?: number };
  };
  resources?: { cpu?: string; memory?: string; disk?: string };
  ports?: {
    port: number;
    url?: string;
    auth?: Record<string, unknown>;
    activationMode?: string;
  }[];
  createdAt?: string;
  region?: string;
}

interface AzureSnapshot {
  id: string;
  labels?: Record<string, string>;
  sandboxId?: string;
  status?: string;
  createdAtUtc?: string;
  sizeInMB?: number;
}

interface AzureExecResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

interface AzureStats {
  cpu?: { user?: number; system?: number };
  network?: { rxBytes?: number; txBytes?: number };
}

export class AzureDataPlaneError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AzureDataPlaneError';
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof AzureDataPlaneError && error.status === 404;
}

function isPortConflict(error: unknown): boolean {
  return error instanceof AzureDataPlaneError && error.status === 409;
}

export class AzureClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'azure';
  public readonly capabilities: ComputeProviderCapabilities =
    AZURE_CAPABILITIES_VALUE;

  private readonly endpoint: string;
  private readonly groupPath: string;
  private readonly fetchImpl: typeof fetch;
  private credentialPromise?: Promise<AzureTokenCredential>;
  private cachedToken?: { token: string; expiresOnTimestamp: number };

  public constructor(private readonly config: AzureConfig) {
    if (!config.subscriptionId)
      throw new Error('Azure requires a subscriptionId');
    if (!config.resourceGroup)
      throw new Error('Azure requires a resourceGroup');
    if (!config.sandboxGroup) throw new Error('Azure requires a sandboxGroup');
    if (!config.region) throw new Error('Azure requires a region');
    if (!config.diskImage) throw new Error('Azure requires a diskImage');

    this.endpoint = `https://management.${config.region}.azuredevcompute.io`;
    this.groupPath =
      `/subscriptions/${config.subscriptionId}` +
      `/resourceGroups/${config.resourceGroup}` +
      `/sandboxGroups/${config.sandboxGroup}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Instances
  // -------------------------------------------------------------------------

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    throwIfAborted(input.signal);

    const sandboxes: AzureSandbox[] = [];
    let nextLink: string | undefined;
    do {
      const page = (
        nextLink
          ? await this.requestRaw('GET', nextLink, { signal: input.signal })
          : await this.request('GET', this.groupPath + '/sandboxes', {
              signal: input.signal,
            })
      ) as { value?: AzureSandbox[]; nextLink?: string } | AzureSandbox[];
      const items = Array.isArray(page) ? page : (page.value ?? []);
      sandboxes.push(...items);
      nextLink = Array.isArray(page) ? undefined : page.nextLink;
    } while (nextLink);

    return sandboxes.map((sandbox) => this.summarize(sandbox));
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    throwIfAborted(input.signal);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const timeoutRemainingMs = this.timeoutRemainingMs(sandbox);
    return {
      status: this.mapState(sandbox.state),
      // Omit when the sandbox has no auto-delete policy: sleep-check's
      // provider-timeout backstop must only see real provider-side deadlines.
      ...(timeoutRemainingMs !== undefined ? { timeoutRemainingMs } : {}),
    };
  }

  public async getInstanceDomains(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult> {
    throwIfAborted(input.signal);
    const domains = await this.ensurePorts(
      input.instanceId,
      input.ports,
      input.signal,
    );
    return { domains };
  }

  public async createInstance(
    input: CreateInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        input.idempotencyKey,
        input.signal,
      );
      if (existing) {
        const domains = await this.ensurePorts(
          existing.id,
          input.ports ?? [],
          input.signal,
        );
        return {
          instanceId: existing.id,
          status: this.mapState(existing.state),
          ...(Object.keys(domains).length > 0 ? { domains } : {}),
        };
      }
    }

    const labels = normalizeLabels({
      ...(input.tags ?? {}),
      ...(input.metadata ?? {}),
      ...(input.idempotencyKey
        ? { [IDEMPOTENCY_LABEL]: input.idempotencyKey }
        : {}),
    });

    const body = this.buildCreateBody({ labels });
    const created = await this.createSandboxAndWait(
      body,
      input.signal,
      'create',
    );
    const domains = await this.ensurePorts(
      created.id,
      input.ports ?? [],
      input.signal,
    );

    return {
      instanceId: created.id,
      status: 'running',
      ...(Object.keys(domains).length > 0 ? { domains } : {}),
    };
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    throwIfAborted(input.signal);

    // Best-effort usage observation before the sandbox disappears.
    const usageObservation = await this.readUsageObservation(input.instanceId);

    try {
      await this.request('DELETE', `${this.sandboxPath(input.instanceId)}`, {
        signal: input.signal,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    return usageObservation ? { usageObservation } : {};
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    throwIfAborted(input.signal);

    if (input.detached) {
      return this.runDetachedCommand(input);
    }

    // NOTE: blocking exec is one-shot with a ~60s wall-clock limit and a
    // 1 MiB stdout cap (the process is killed past either). Callers needing
    // more must use `detached`.
    const command = buildShellCommand(input);
    const result = (await this.request(
      'POST',
      `${this.sandboxPath(input.instanceId)}/executeShellCommand`,
      {
        body: {
          command,
          ...(input.cwd ? { workingDirectory: input.cwd } : {}),
        },
        signal: input.signal,
        abortMessage: `Running command in Azure sandbox ${input.instanceId} was aborted`,
      },
    )) as AzureExecResult;

    if (input.onOutput) {
      if (result.stdout) {
        input.onOutput({ stream: 'stdout', data: result.stdout });
      }
      if (result.stderr) {
        input.onOutput({ stream: 'stderr', data: result.stderr });
      }
    }

    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async runDetachedCommand(
    input: RunCommandInput,
  ): Promise<RunCommandResult> {
    const commandId = `azc-${randomUUID()}`;
    const paths = detachedPaths(commandId);

    const inner = [
      input.cwd ? `cd ${shellQuote(input.cwd)} && ` : '',
      buildShellCommand(input),
      `; printf '%s' $? > ${shellQuote(paths.exit)}`,
    ].join('');

    const launch =
      `mkdir -p ${shellQuote(DETACHED_LOG_ROOT)} && ` +
      `nohup bash -c ${shellQuote(inner)} ` +
      `> ${shellQuote(paths.stdout)} 2> ${shellQuote(paths.stderr)} ` +
      `& echo $!`;

    const launchResult = (await this.request(
      'POST',
      `${this.sandboxPath(input.instanceId)}/executeShellCommand`,
      {
        body: { command: launch },
        signal: input.signal,
        abortMessage: `Launching detached command in Azure sandbox ${input.instanceId} was aborted`,
      },
    )) as AzureExecResult;

    if (launchResult.exitCode !== 0) {
      return {
        commandId,
        exitCode: launchResult.exitCode ?? 1,
        stdout: launchResult.stdout,
        stderr: launchResult.stderr,
      };
    }

    // Give fast-failing commands a moment to land in the exit sentinel so
    // callers see immediate failures synchronously.
    await sleepWithSignal(DETACHED_START_GRACE_MS, input.signal);
    const earlyExit = await this.readExitCode(input.instanceId, commandId);

    if (input.onExit) {
      this.watchDetachedExit(input, commandId);
    }

    if (earlyExit !== null) {
      const [stdout, stderr] = await Promise.all([
        this.readFileText(input.instanceId, paths.stdout, input.signal),
        this.readFileText(input.instanceId, paths.stderr, input.signal),
      ]);
      return { commandId, exitCode: earlyExit, stdout, stderr };
    }

    return { commandId, exitCode: null };
  }

  /**
   * Background watcher: polls the exit sentinel and reports a detached
   * command's exit through `onExit`. Fire-and-forget; errors are swallowed
   * (a destroyed sandbox ends the watch via repeated read failures).
   */
  private watchDetachedExit(input: RunCommandInput, commandId: string): void {
    const onExit = input.onExit;
    if (!onExit) return;

    const instanceId = input.instanceId;
    void (async () => {
      const deadline = Date.now() + DETACHED_EXIT_POLL_MAX_MS;
      let consecutiveErrors = 0;
      while (Date.now() < deadline) {
        try {
          const exitCode = await this.readExitCode(instanceId, commandId);
          if (exitCode !== null) {
            await onExit({ exitCode });
            return;
          }
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 10) return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DETACHED_EXIT_POLL_INTERVAL_MS);
          // Let the process exit even if a watch is still pending.
          (timer as { unref?: () => void }).unref?.();
        });
      }
    })();
  }

  public async *streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    const paths = detachedPaths(input.commandId);
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let exited = false;

    while (true) {
      throwIfAborted(input.signal);

      const [stdout, stderr] = await Promise.all([
        this.readFileText(input.instanceId, paths.stdout, input.signal),
        this.readFileText(input.instanceId, paths.stderr, input.signal),
      ]);

      if (stdout.length > stdoutOffset) {
        yield { stream: 'stdout', data: stdout.slice(stdoutOffset) };
        stdoutOffset = stdout.length;
      }
      if (stderr.length > stderrOffset) {
        yield { stream: 'stderr', data: stderr.slice(stderrOffset) };
        stderrOffset = stderr.length;
      }

      if (exited) return;
      exited =
        (await this.readExitCode(input.instanceId, input.commandId)) !== null;
      if (!exited) {
        await sleepWithSignal(STREAM_POLL_INTERVAL_MS, input.signal);
      }
    }
  }

  public async getCommandOutput(input: GetCommandOutputInput): Promise<string> {
    const paths = detachedPaths(input.commandId);
    const wantStdout = input.stream !== 'stderr';
    const wantStderr = input.stream !== 'stdout';

    const [stdout, stderr] = await Promise.all([
      wantStdout
        ? this.readFileText(input.instanceId, paths.stdout, input.signal)
        : Promise.resolve(''),
      wantStderr
        ? this.readFileText(input.instanceId, paths.stderr, input.signal)
        : Promise.resolve(''),
    ]);

    // The detached scheme keeps stdout/stderr in separate files; "both"
    // concatenates (matches the e2b adapter's combined-log behavior).
    return stdout + stderr;
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  public async writeFiles(input: WriteFileInput): Promise<void> {
    throwIfAborted(input.signal);
    await Promise.all(
      input.files.map(async (file) => {
        await this.request(
          'PUT',
          `${this.sandboxPath(input.instanceId)}/files`,
          {
            query: { path: file.path, createDirs: 'true' },
            binaryBody: file.content,
            signal: input.signal,
            abortMessage: `Writing ${file.path} in Azure sandbox ${input.instanceId} was aborted`,
          },
        );
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  public async createSnapshot(
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);

    const snapshotName = deriveAzureProductSnapshotName(input.instanceId);
    const usageObservation = await this.readUsageObservation(input.instanceId);

    // ACA snapshots capture memory+disk and get restored into future
    // sandboxes — purge CLOSED detached-command logs first so stale output
    // (and anything it contains) doesn't ride into every restored sandbox.
    // Only triples with an exit sentinel are removed: the in-flight worker's
    // own logs stay readable after restore, and its exit watcher keeps
    // working. Best effort; the snapshot is still valid without the purge.
    await this.request(
      'POST',
      `${this.sandboxPath(input.instanceId)}/executeShellCommand`,
      {
        body: {
          command:
            'find ' +
            shellQuote(DETACHED_LOG_ROOT) +
            ' -name \'*.exit\' -exec sh -c \'p=${1%.exit}; rm -f "$p.exit" "$p.stdout.log" "$p.stderr.log"\' _ {} \\;',
        },
        signal: input.signal,
        abortMessage: `Purging detached logs before snapshotting Azure sandbox ${input.instanceId} was aborted`,
      },
    ).catch(() => {
      // Continue; stale logs are a hygiene issue, not a correctness one.
    });

    // The dataplane snapshot endpoint is synchronous: the returned body
    // already carries the snapshot id.
    const snapshot = (await this.request(
      'POST',
      `${this.sandboxPath(input.instanceId)}/snapshot`,
      {
        body: { labels: { name: snapshotName } },
        signal: input.signal,
        abortMessage: `Creating snapshot of Azure sandbox ${input.instanceId} was aborted`,
      },
    )) as AzureSnapshot;

    // Persist the id before teardown: a crash between destroy and caller
    // persistence would otherwise orphan the snapshot (see CreateSnapshotInput).
    await input.onSnapshotCreated?.(snapshot.id);

    await this.destroySandboxAfterSnapshot(input.instanceId);

    return {
      snapshotId: snapshot.id,
      ...(usageObservation ? { usageObservation } : {}),
    };
  }

  public async findSnapshotBySourceInstance(
    input: FindSnapshotBySourceInstanceInput,
  ): Promise<SourceInstanceSnapshot | null> {
    throwIfAborted(input.signal);

    const snapshots: AzureSnapshot[] = [];
    let nextLink: string | undefined;
    do {
      const page = (
        nextLink
          ? await this.requestRaw('GET', nextLink, { signal: input.signal })
          : await this.request('GET', `${this.groupPath}/snapshots`, {
              signal: input.signal,
            })
      ) as { value?: AzureSnapshot[]; nextLink?: string } | AzureSnapshot[];
      const items = Array.isArray(page) ? page : (page.value ?? []);
      snapshots.push(...items);
      nextLink = Array.isArray(page) ? undefined : page.nextLink;
    } while (nextLink);

    const matches = snapshots
      .filter((snapshot) => snapshot.sandboxId === input.instanceId)
      .filter((snapshot) => {
        if (!snapshot.createdAtUtc) return true;
        const createdAt = new Date(snapshot.createdAtUtc);
        if (input.since && createdAt < input.since) return false;
        if (input.until && createdAt > input.until) return false;
        return true;
      })
      .sort((a, b) =>
        (b.createdAtUtc ?? '').localeCompare(a.createdAtUtc ?? ''),
      );

    const match = matches[0];
    if (!match) return null;

    return {
      snapshotId: match.id,
      sourceInstanceId: input.instanceId,
      status: 'created',
      createdAt: match.createdAtUtc
        ? new Date(match.createdAtUtc)
        : new Date(0),
    };
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    const labels = normalizeLabels({
      ...(input.tags ?? {}),
      ...(input.metadata ?? {}),
    });

    const body: Record<string, unknown> = {
      sourcesRef: { snapshot: { id: input.sourceSnapshotId } },
      ...(labels ? { labels } : {}),
    };

    // Snapshot restore replays captured state; older previews rejected
    // labels on restore, newer ones accept them. Fall back to a bare restore
    // when the service rejects the labeled body.
    let created: AzureSandbox;
    try {
      created = await this.createSandboxAndWait(body, input.signal, 'resume');
    } catch (error) {
      if (
        labels &&
        error instanceof AzureDataPlaneError &&
        error.status === 400
      ) {
        created = await this.createSandboxAndWait(
          { sourcesRef: { snapshot: { id: input.sourceSnapshotId } } },
          input.signal,
          'resume',
        );
      } else {
        throw error;
      }
    }

    // Ports do NOT persist through snapshot/restore (measured) — re-add.
    const domains = await this.ensurePorts(
      created.id,
      input.ports ?? [],
      input.signal,
    );

    return {
      instanceId: created.id,
      status: 'running',
      sourceSnapshotId: input.sourceSnapshotId,
      ...(Object.keys(domains).length > 0 ? { domains } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Standby (ACA suspend/resume preserves full memory+disk)
  // -------------------------------------------------------------------------

  public async enterStandby(
    input: EnterStandbyInput,
  ): Promise<EnterStandbyResult> {
    throwIfAborted(input.signal);

    const usageObservation = await this.readUsageObservation(input.instanceId);

    await this.request('POST', `${this.sandboxPath(input.instanceId)}/stop`, {
      signal: input.signal,
      abortMessage: `Suspending Azure sandbox ${input.instanceId} was aborted`,
    });
    await this.waitForState(
      input.instanceId,
      ['Stopped', 'Suspended', 'Idle'],
      input.signal,
    );

    return {
      resumeHandle: input.instanceId,
      ...(usageObservation ? { usageObservation } : {}),
    };
  }

  public async resumeFromStandby(
    input: ResumeFromStandbyInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    // No-op when already Running (double-wake race): resuming a Running
    // sandbox is rejected by the service.
    const current = await this.getSandbox(input.resumeHandle, input.signal);
    if (current.state !== 'Running') {
      await this.request(
        'POST',
        `${this.sandboxPath(input.resumeHandle)}/resume`,
        {
          signal: input.signal,
          abortMessage: `Resuming Azure sandbox ${input.resumeHandle} was aborted`,
        },
      );
      await this.waitForState(input.resumeHandle, ['Running'], input.signal);
    }

    // Refresh the auto-delete window: the policy interval is measured from
    // sandbox creation, so without this a resumed worker's fresh Roomote
    // timeout would outlive the provider-side deadline (and standby
    // retention beyond one timeout window would be unreachable). Preserves
    // the sandbox's existing auto-suspend policy.
    if (this.config.timeoutMs) {
      await this.request(
        'POST',
        `${this.sandboxPath(input.resumeHandle)}/lifecycle`,
        {
          body: {
            autoSuspendPolicy: current.lifecycle?.autoSuspendPolicy ?? {
              enabled: false,
            },
            autoDeletePolicy: {
              enabled: true,
              deleteIntervalInSeconds: Math.ceil(this.config.timeoutMs / 1_000),
            },
          },
          signal: input.signal,
          abortMessage: `Refreshing auto-delete policy for Azure sandbox ${input.resumeHandle} was aborted`,
        },
      );
    }

    // Ports persist through stop/resume (measured); ensure anyway so callers
    // always get domains back.
    const domains = await this.ensurePorts(
      input.resumeHandle,
      input.ports ?? [],
      input.signal,
    );

    return {
      instanceId: input.resumeHandle,
      sourceSnapshotId: input.resumeHandle,
      status: 'running',
      ...(Object.keys(domains).length > 0 ? { domains } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sandboxPath(sandboxId: string): string {
    return `${this.groupPath}/sandboxes/${sandboxId}`;
  }

  private async getSandbox(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<AzureSandbox> {
    return (await this.request('GET', this.sandboxPath(sandboxId), {
      signal,
    })) as AzureSandbox;
  }

  private async findByIdempotencyKey(
    key: string,
    signal?: AbortSignal,
  ): Promise<AzureSandbox | null> {
    const page = (await this.request('GET', `${this.groupPath}/sandboxes`, {
      query: { labels: `${IDEMPOTENCY_LABEL}=${key}` },
      signal,
    })) as { value?: AzureSandbox[] } | AzureSandbox[];
    const items = Array.isArray(page) ? page : (page.value ?? []);
    return (
      items.find(
        (sandbox) => sandbox.state !== 'Deleting' && sandbox.state !== 'Failed',
      ) ?? null
    );
  }

  private buildCreateBody(options: {
    labels?: Record<string, string>;
  }): Record<string, string | Record<string, unknown>> {
    const diskImage = this.config.diskImage.startsWith('public:')
      ? {
          name: this.config.diskImage.slice('public:'.length),
          isPublic: true,
        }
      : { id: this.config.diskImage };

    const autoSuspendSeconds = this.config.autoSuspendSeconds ?? 0;

    // ACA tiers cap memory at cores × 2Gi (e.g. 1000m → max 2048Mi;
    // verified live: 400 InvalidResourceTier otherwise). Scale CPU up to fit
    // the requested memory rather than failing.
    const memoryMiB = this.config.memoryMiB ?? DEFAULT_MEMORY_MIB;
    const minCpuMillicores = Math.ceil(memoryMiB / 2048) * 1000;
    const cpuMillicores = Math.max(
      this.config.cpuMillicores ?? DEFAULT_CPU_MILLICORES,
      minCpuMillicores,
    );

    return {
      sourcesRef: { diskImage },
      resources: {
        cpu: `${cpuMillicores}m`,
        memory: `${memoryMiB}Mi`,
        ...(this.config.diskSize ? { disk: this.config.diskSize } : {}),
      },
      lifecycle: {
        autoSuspendPolicy: {
          enabled: autoSuspendSeconds > 0,
          interval: autoSuspendSeconds,
          mode: 'Memory',
        },
        ...(this.config.timeoutMs
          ? {
              autoDeletePolicy: {
                enabled: true,
                deleteIntervalInSeconds: Math.ceil(
                  this.config.timeoutMs / 1_000,
                ),
              },
            }
          : {}),
      },
      // Default Partial inspection: no rules configured means no TLS
      // resigning at all (clean trust stores, SSH allowed). See AzureConfig.
      egressPolicy: {
        defaultAction: 'Allow',
        trafficInspection: this.config.egressTrafficInspection ?? 'Partial',
      },
      ...(options.labels ? { labels: options.labels } : {}),
    };
  }

  /**
   * PUT the create body and poll until Running. On abort, best-effort delete
   * a late-created sandbox so it is not leaked (mirrors the daytona adapter's
   * onLateResolve cleanup).
   */
  private async createSandboxAndWait(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    operation: 'create' | 'resume',
  ): Promise<AzureSandbox> {
    const created = await raceWithAbort({
      promise: this.request('PUT', `${this.groupPath}/sandboxes`, {
        body,
      }) as Promise<AzureSandbox>,
      signal,
      abortMessage: `Azure sandbox ${operation} was aborted`,
      onLateResolve: async (sandbox) => {
        await this.cleanupSandboxAfterFailure(sandbox.id);
      },
    });

    try {
      await this.waitForState(created.id, ['Running'], signal);
    } catch (error) {
      await this.cleanupSandboxAfterFailure(created.id);
      throw error;
    }

    return this.getSandbox(created.id, signal);
  }

  private async waitForState(
    sandboxId: string,
    targetStates: string[],
    signal?: AbortSignal,
  ): Promise<AzureSandbox> {
    const deadline = Date.now() + RUNNING_POLL_TIMEOUT_MS;
    while (true) {
      throwIfAborted(
        signal,
        `Waiting for Azure sandbox ${sandboxId} was aborted`,
      );
      const sandbox = await this.getSandbox(sandboxId, signal);
      const state = sandbox.state ?? '';
      if (targetStates.includes(state)) {
        return sandbox;
      }
      if (state === 'Failed' || state === 'Deleting') {
        throw new Error(
          `Azure sandbox ${sandboxId} entered terminal state '${state}'`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Azure sandbox ${sandboxId} did not reach [${targetStates.join(', ')}] within ${RUNNING_POLL_TIMEOUT_MS}ms (last state: '${state}')`,
        );
      }
      logHttp('waitForState poll', { sandboxId, state });
      await sleepWithSignal(RUNNING_POLL_INTERVAL_MS, signal);
    }
  }

  /**
   * Add the requested ports (anonymous, OnDemand activation so inbound
   * traffic wakes a suspended sandbox — measured 2026-07-28) and return
   * deterministic per-port URLs. Re-adding an existing port is a 409, which
   * is treated as success.
   */
  private async ensurePorts(
    sandboxId: string,
    ports: number[],
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const domains: Record<string, string> = {};
    for (const port of ports) {
      try {
        await this.request('POST', `${this.sandboxPath(sandboxId)}/ports/add`, {
          body: {
            port,
            auth: { anonymous: true },
            activationMode: 'OnDemand',
          },
          signal,
          abortMessage: `Exposing port ${port} on Azure sandbox ${sandboxId} was aborted`,
        });
      } catch (error) {
        if (!isPortConflict(error)) throw error;
      }
      domains[String(port)] = this.computePortUrl(sandboxId, port);
    }
    return domains;
  }

  /**
   * Port URLs are deterministic: {sandboxId}--{port}.{region}.adcproxy.io
   * (measured 2026-07-28).
   */
  private computePortUrl(sandboxId: string, port: number): string {
    return `https://${sandboxId}--${port}.${this.config.region}.adcproxy.io`;
  }

  private async readExitCode(
    sandboxId: string,
    commandId: string,
  ): Promise<number | null> {
    // Missing sentinel (404 → '') means the command is still running.
    const text = await this.readFileText(
      sandboxId,
      detachedPaths(commandId).exit,
    );
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async readFileText(
    sandboxId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const buffer = (await this.request(
        'GET',
        `${this.sandboxPath(sandboxId)}/files`,
        {
          query: { path },
          rawResponse: true,
          signal,
        },
      )) as ArrayBuffer;
      return Buffer.from(buffer).toString('utf8');
    } catch (error) {
      if (isNotFound(error)) return '';
      throw error;
    }
  }

  private async readUsageObservation(sandboxId: string) {
    try {
      const stats = (await this.request(
        'GET',
        `${this.sandboxPath(sandboxId)}/stats`,
      )) as AzureStats;
      const user = stats.cpu?.user ?? 0;
      const system = stats.cpu?.system ?? 0;
      const rxBytes = stats.network?.rxBytes ?? 0;
      const txBytes = stats.network?.txBytes ?? 0;
      if (user + system + rxBytes + txBytes === 0) return undefined;
      return {
        // cpu user/system are USER_HZ jiffies (100/s → ×10ms).
        activeCpuDurationMs: (user + system) * 10,
        networkTransfer: { ingress: rxBytes, egress: txBytes },
      };
    } catch {
      return undefined;
    }
  }

  private async destroySandboxAfterSnapshot(sandboxId: string): Promise<void> {
    try {
      await this.request('DELETE', this.sandboxPath(sandboxId));
    } catch {
      // Snapshot already captured; the caller's cleanup / sleep-check sweeps.
    }
  }

  private async cleanupSandboxAfterFailure(sandboxId: string): Promise<void> {
    try {
      await this.request('DELETE', this.sandboxPath(sandboxId));
    } catch {
      // Best effort.
    }
  }

  private summarize(sandbox: AzureSandbox): InstanceSummary {
    return {
      instanceId: sandbox.id,
      status: this.mapState(sandbox.state),
      // InstanceSummary requires a number; "no policy" reads as far-future.
      timeoutRemainingMs:
        this.timeoutRemainingMs(sandbox) ?? Number.MAX_SAFE_INTEGER,
      ...(sandbox.createdAt ? { createdAt: new Date(sandbox.createdAt) } : {}),
    };
  }

  /**
   * Remaining lifetime from the sandbox's own auto-delete lifecycle policy
   * (server-side truth, set at create from the configured timeout). Returns
   * undefined when the sandbox has no auto-delete deadline — regardless of
   * what this particular client is configured with (sleep-check clients
   * carry no timeoutMs and must not see a phantom expiry).
   */
  private timeoutRemainingMs(sandbox: AzureSandbox): number | undefined {
    const autoDelete = sandbox.lifecycle?.autoDeletePolicy;
    if (!autoDelete?.enabled || !autoDelete.deleteIntervalInSeconds) {
      return undefined;
    }
    if (!sandbox.createdAt) return undefined;
    const deadlineMs =
      new Date(sandbox.createdAt).getTime() +
      autoDelete.deleteIntervalInSeconds * 1_000;
    return Math.max(0, deadlineMs - Date.now());
  }

  private mapState(state: string | undefined): ComputeInstanceStatus {
    switch (state) {
      case 'Creating':
      case 'Resuming':
        return 'pending';
      case 'Running':
        return 'running';
      case 'Stopping':
      case 'Deleting':
        return 'stopping';
      case 'Stopped':
      case 'Suspended':
      case 'Idle':
        return 'stopped';
      case 'Failed':
        return 'failed';
      default:
        return 'unknown';
    }
  }

  // -------------------------------------------------------------------------
  // HTTP transport
  // -------------------------------------------------------------------------

  private async getToken(signal?: AbortSignal): Promise<string> {
    if (this.config.tokenProvider) {
      return this.config.tokenProvider.getToken();
    }

    const now = Date.now();
    if (
      this.cachedToken &&
      this.cachedToken.expiresOnTimestamp - 5 * 60 * 1_000 > now
    ) {
      return this.cachedToken.token;
    }

    const tokenStart = Date.now();
    if (!this.credentialPromise) {
      logHttp('credential init', {
        kind: this.config.servicePrincipal
          ? 'service-principal'
          : this.config.managedIdentityClientId
            ? 'user-assigned-mi'
            : 'default-chain',
      });
      this.credentialPromise = createAzureCredential({
        ...(this.config.servicePrincipal
          ? { servicePrincipal: this.config.servicePrincipal }
          : {}),
        ...(this.config.managedIdentityClientId
          ? { managedIdentityClientId: this.config.managedIdentityClientId }
          : {}),
      });
    }
    const credential = await this.credentialPromise;
    throwIfAborted(signal);
    const token = await acquireAzureToken(credential, DATA_PLANE_SCOPE);
    this.cachedToken = token;
    logHttp('token acquired', { durationMs: Date.now() - tokenStart });
    return token.token;
  }

  private async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      binaryBody?: Buffer;
      rawResponse?: boolean;
      signal?: AbortSignal;
      abortMessage?: string;
    } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.endpoint}${path}`);
    url.searchParams.set('api-version', API_VERSION);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    return this.requestRaw(method, url.toString(), options);
  }

  private async requestRaw(
    method: string,
    url: string,
    options: {
      body?: Record<string, unknown>;
      binaryBody?: Buffer;
      rawResponse?: boolean;
      signal?: AbortSignal;
      abortMessage?: string;
    } = {},
  ): Promise<unknown> {
    let attempt = 0;
    let delayMs = RETRY_INITIAL_DELAY_MS;

    while (true) {
      attempt += 1;
      throwIfAborted(options.signal, options.abortMessage);

      const attemptStart = Date.now();
      logHttp('request start', { method, url, attempt });

      const token = await this.getToken(options.signal);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (options.binaryBody) {
        headers['content-type'] = 'application/octet-stream';
      } else if (options.body) {
        headers['content-type'] = 'application/json';
      }

      let response: Response;
      try {
        response = await raceWithAbort({
          promise: this.fetchImpl(url, {
            method,
            headers,
            body: options.binaryBody
              ? new Uint8Array(options.binaryBody)
              : options.body
                ? JSON.stringify(options.body)
                : undefined,
            signal: options.signal,
          }),
          signal: options.signal,
          abortMessage: options.abortMessage,
        });
      } catch (error) {
        logHttp('request error', {
          method,
          url,
          attempt,
          durationMs: Date.now() - attemptStart,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < RETRY_MAX_ATTEMPTS && !isAbortLike(error)) {
          await sleepWithSignal(delayMs, options.signal);
          delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
          continue;
        }
        throw error;
      }

      logHttp('request end', {
        method,
        url,
        attempt,
        status: response.status,
        durationMs: Date.now() - attemptStart,
      });

      if (response.status < 400) {
        if (options.rawResponse) {
          return response.arrayBuffer();
        }
        if (response.status === 204) return {};
        const text = await response.text();
        if (!text) return {};
        return JSON.parse(text);
      }

      const errorText = await response.text().catch(() => '');
      const { code, message } = parseAzureError(errorText);
      const error = new AzureDataPlaneError(
        message ||
          `Azure data plane ${method} ${url} failed with status ${response.status}`,
        response.status,
        code,
      );

      const retriableStatus =
        response.status === 403 || // RBAC propagation after role assignment
        response.status === 429 ||
        (response.status >= 500 && (method === 'GET' || method === 'DELETE'));
      if (retriableStatus && attempt < RETRY_MAX_ATTEMPTS) {
        logHttp('request retry', {
          method,
          url,
          attempt,
          status: response.status,
          delayMs,
        });
        await sleepWithSignal(delayMs, options.signal);
        delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
        continue;
      }

      throw error;
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function detachedPaths(commandId: string): {
  stdout: string;
  stderr: string;
  exit: string;
} {
  return {
    stdout: `${DETACHED_LOG_ROOT}/${commandId}.stdout.log`,
    stderr: `${DETACHED_LOG_ROOT}/${commandId}.stderr.log`,
    exit: `${DETACHED_LOG_ROOT}/${commandId}.exit`,
  };
}

function buildShellCommand(input: RunCommandInput): string {
  const envTokens = Object.entries(input.env ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  return shellJoin(['env', ...envTokens, input.cmd, ...(input.args ?? [])]);
}

const SHELL_SAFE_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(value: string): string {
  if (value.length > 0 && SHELL_SAFE_PATTERN.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

function normalizeLabels(
  labels: Record<string, string>,
): Record<string, string> | undefined {
  const entries = Object.entries(labels).filter(
    ([key, value]) => key.length > 0 && value.length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Product task/env snapshot names must not collide with the worker base disk
 * image (`AZURE_SANDBOX_DISK_IMAGE`).
 */
export function deriveAzureProductSnapshotName(instanceId: string): string {
  const sanitizedInstance = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 24);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${PRODUCT_SNAPSHOT_NAME_PREFIX}-${sanitizedInstance}-${suffix}`;
}

function parseAzureError(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as {
      title?: string;
      detail?: string;
      errorCode?: number | string;
      error?: { code?: string; message?: string };
      message?: string;
    };
    return {
      code:
        parsed.error?.code ??
        parsed.title ??
        (parsed.errorCode !== undefined ? String(parsed.errorCode) : undefined),
      message: parsed.error?.message ?? parsed.detail ?? parsed.message,
    };
  } catch {
    return {};
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
