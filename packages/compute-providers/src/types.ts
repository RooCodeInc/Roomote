import type { ComputeProvider } from '@roomote/types';

export type {
  ComputeProviderMutationEvent,
  ComputeProviderMutationObserver,
  ComputeProviderMutationOperation,
} from '@roomote/types';

export type ComputeInstanceStatus =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'snapshotting'
  | 'unknown';

import type { ComputeProviderCapabilities } from '@roomote/types';

export type { ComputeProviderCapabilities } from '@roomote/types';

export interface CreateInstanceInput {
  /** Stable caller-owned key used by providers that support idempotent create. */
  idempotencyKey?: string;
  ports?: number[];
  metadata?: Record<string, string>;
  tags?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ResumeInstanceInput extends CreateInstanceInput {
  sourceSnapshotId: string;
}

export interface EnterStandbyInput {
  instanceId: string;
  commandId?: string;
  signal?: AbortSignal;
}

export interface EnterStandbyResult {
  /** Opaque single-instance handle used to reconnect to this standby. */
  resumeHandle: string;
  usageObservation?: ComputeUsageObservation;
}

export interface ResumeFromStandbyInput extends CreateInstanceInput {
  resumeHandle: string;
}

export interface CreatedInstance {
  instanceId: string;
  status?: ComputeInstanceStatus;
  sourceSnapshotId?: string;
  domains?: Record<string, string>;
}

export interface DestroyInstanceInput {
  instanceId: string;
  signal?: AbortSignal;
}

export interface ComputeUsageObservation {
  activeCpuDurationMs?: number;
  networkTransfer?: {
    ingress: number;
    egress: number;
  };
}

export interface DestroyInstanceResult {
  usageObservation?: ComputeUsageObservation;
}

export type OutputCallback = (event: CommandOutputEvent) => void;

export interface CommandExitEvent {
  exitCode: number;
}

export type ExitCallback = (event: CommandExitEvent) => void | Promise<void>;

export interface RunCommandInput {
  instanceId: string;
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  signal?: AbortSignal;
  onOutput?: OutputCallback;
  /** Called when a detached command exits after launch has been reported. */
  onExit?: ExitCallback;
}

export interface RunCommandResult {
  commandId?: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface CommandOutputEvent {
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface StreamCommandOutputInput {
  instanceId: string;
  commandId: string;
  signal?: AbortSignal;
}

export interface GetCommandOutputInput {
  instanceId: string;
  commandId: string;
  stream?: 'stdout' | 'stderr' | 'both';
  signal?: AbortSignal;
}

export interface GetInstanceStatusInput {
  instanceId: string;
  signal?: AbortSignal;
}

export interface GetInstanceStatusResult {
  status: ComputeInstanceStatus;
  timeoutRemainingMs?: number;
}

export interface GetInstanceDomainsInput {
  instanceId: string;
  ports: number[];
  signal?: AbortSignal;
}

export interface GetInstanceDomainsResult {
  domains: Record<string, string>;
}

export interface WriteFileInput {
  instanceId: string;
  files: { path: string; content: Buffer }[];
  signal?: AbortSignal;
}

export interface CreateSnapshotInput {
  instanceId: string;
  signal?: AbortSignal;
  /**
   * Durably record the snapshot id the moment the provider produces it, before
   * the adapter tears the source instance down. Adapters snapshot and then
   * destroy the sandbox, so the id only reaches the caller after that teardown
   * returns; a crash or a stalled-job redelivery in between used to lose an
   * otherwise-good snapshot for good. Providers expose no lookup by source
   * instance (Modal images are addressable only by id), so the id cannot be
   * recovered afterwards -- it has to be persisted the instant it exists.
   *
   * Called at most once per successful snapshot. Adapters must let a rejection
   * propagate: failing to persist means the snapshot is unreachable, and the
   * caller needs the failure rather than a sandbox destroyed for nothing.
   */
  onSnapshotCreated?: (snapshotId: string) => Promise<void>;
}

export interface CreateSnapshotResult {
  snapshotId: string;
  usageObservation?: ComputeUsageObservation;
}

export interface SourceInstanceSnapshot {
  snapshotId: string;
  sourceInstanceId: string;
  status: 'created' | 'failed' | 'deleted';
  createdAt: Date;
  expiresAt?: Date;
}

export interface FindSnapshotBySourceInstanceInput {
  instanceId: string;
  since?: Date;
  until?: Date;
  signal?: AbortSignal;
}

export interface InstanceSummary {
  instanceId: string;
  status: ComputeInstanceStatus;
  /** Milliseconds remaining before the instance times out. */
  timeoutRemainingMs: number;
  createdAt?: Date;
}

export interface ListInstancesInput {
  signal?: AbortSignal;
}

export interface ComputeProviderClient {
  readonly vendor: ComputeProvider;
  readonly capabilities: ComputeProviderCapabilities;

  listInstances(input: ListInstancesInput): Promise<InstanceSummary[]>;

  getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult>;
  getInstanceDomains?(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult>;
  createInstance(input: CreateInstanceInput): Promise<CreatedInstance>;
  destroyInstance(input: DestroyInstanceInput): Promise<DestroyInstanceResult>;

  runCommand(input: RunCommandInput): Promise<RunCommandResult>;
  streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent>;
  getCommandOutput(input: GetCommandOutputInput): Promise<string>;

  writeFiles(input: WriteFileInput): Promise<void>;

  createSnapshot(input: CreateSnapshotInput): Promise<CreateSnapshotResult>;
  findSnapshotBySourceInstance?(
    input: FindSnapshotBySourceInstanceInput,
  ): Promise<SourceInstanceSnapshot | null>;
  resumeFromSnapshot(input: ResumeInstanceInput): Promise<CreatedInstance>;
  enterStandby?(input: EnterStandbyInput): Promise<EnterStandbyResult>;
  resumeFromStandby?(input: ResumeFromStandbyInput): Promise<CreatedInstance>;
}

export interface ModalConfig {
  /**
   * Vendor identity the client reports (and task runs persist). The
   * deployment-managed `roomote` provider runs on the same Modal
   * machinery with its own credentials. Defaults to `modal`.
   */
  vendor?: Extract<ComputeProvider, 'modal' | 'roomote'>;
  /** Modal token ID (e.g. `ak-...`). */
  tokenId: string;
  /** Modal token secret (e.g. `as-...`). */
  tokenSecret: string;
  /** Custom gRPC endpoint for the Modal API. */
  endpoint?: string;
  /** Modal environment name. */
  environment?: string;
  /** Modal app name used to group sandboxes. Defaults to `"roomote"`. */
  appName?: string;
  /** Baked worker image reference for fresh sandboxes. */
  baseImageRef: string;
  /** Static username for private non-ECR registry pulls. */
  registryUsername?: string;
  /** Static access token or password for private non-ECR registry pulls. */
  registryPassword?: string;
  /** AWS IAM role ARN used by Modal OIDC for ECR pulls. */
  ecrOidcRoleArn?: string;
  /** AWS region for ECR pulls in OIDC mode. */
  ecrRegion?: string;
  /**
   * Optional Modal container placement region(s) for new sandboxes
   * (`MODAL_REGIONS`). When unset, Modal chooses placement automatically.
   * Tokens match Modal's broad/narrow region list (e.g. `us`, `us-west`).
   */
  regions?: string[];
  /** Maximum sandbox lifetime in milliseconds. Modal defaults to 5 minutes if unset. */
  timeoutMs?: number;
  /** CPU core reservation (can be fractional, e.g. 8). */
  cpu?: number;
  /** Hard CPU cap in physical cores (can be fractional, e.g. 8). */
  cpuLimit?: number;
  /** Memory reservation in MiB (e.g. 16384 for 16 GB). */
  memoryMiB?: number;
  /** Hard memory cap in MiB (e.g. 16384 for 16 GB). */
  memoryLimitMiB?: number;
  /** Use Modal's VM sandbox runtime for nested Docker workloads. */
  vmRuntime?: boolean;
}

export interface RoomoteBrokerConfig {
  /** Base URL of the hosting operator's compute broker. */
  brokerUrl: string;
  /** Deployment id; the broker's tenant identity (`ROOMOTE_CLOUD_TOKEN_ID`). */
  tenantId: string;
  /** Derived per-tenant broker credential (`ROOMOTE_CLOUD_TOKEN_SECRET`). */
  brokerKey: string;
  /** Baked worker image reference for fresh sandboxes. */
  baseImageRef: string;
  /** Optional Modal placement region(s), enforced server-side. */
  regions?: string[];
  /** Maximum sandbox lifetime in milliseconds, clamped server-side. */
  timeoutMs?: number;
  /** CPU core reservation (can be fractional). */
  cpu?: number;
  /** Hard CPU cap in physical cores. */
  cpuLimit?: number;
  /** Memory reservation in MiB. */
  memoryMiB?: number;
  /** Hard memory cap in MiB. */
  memoryLimitMiB?: number;
  /** Use the VM sandbox runtime for nested Docker workloads. */
  vmRuntime?: boolean;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DockerConfig {
  /** Local Docker image used for worker containers. */
  image?: string;
}

export interface DaytonaConfig {
  /** Daytona API key (`DAYTONA_API_KEY`). */
  apiKey: string;
  /** Custom Daytona API URL (`DAYTONA_API_URL`). Defaults to the Daytona cloud. */
  apiUrl?: string;
  /** Target region for new sandboxes (`DAYTONA_TARGET`). */
  target?: string;
  /**
   * Name of the Daytona snapshot used as the base image for fresh sandboxes
   * (`DAYTONA_SNAPSHOT_NAME`). The snapshot must exist in the authenticated
   * Daytona organization and is typically registered once from the public
   * Roomote worker image.
   */
  snapshotName: string;
  /** Maximum sandbox lifetime in milliseconds, enforced via auto-stop. */
  timeoutMs?: number;
  /** Memory allocated to the sandbox in GiB. */
  memoryGiB?: number;
}

export interface E2bConfig {
  /** E2B API key (`E2B_API_KEY`). */
  apiKey: string;
  /** Custom E2B domain (`E2B_DOMAIN`) for self-hosted clusters. Defaults to the E2B cloud. */
  domain?: string;
  /**
   * ID or name of the E2B template used as the base image for fresh sandboxes
   * (`E2B_TEMPLATE_ID`). The template must exist in the authenticated E2B
   * team and is typically built once from the public Roomote worker image.
   */
  templateId: string;
  /** Maximum sandbox lifetime in milliseconds, enforced via the sandbox timeout. */
  timeoutMs?: number;
}

export interface AzureConfig {
  /** Azure subscription ID (`AZURE_SUBSCRIPTION_ID`). */
  subscriptionId: string;
  /** Azure resource group containing the sandbox group (`AZURE_RESOURCE_GROUP`). */
  resourceGroup: string;
  /** Sandbox group name (`AZURE_SANDBOX_GROUP`). */
  sandboxGroup: string;
  /** Data-plane region (`AZURE_SANDBOX_REGION`), e.g. `canadacentral`. */
  region: string;
  /**
   * Disk image used as the base for fresh sandboxes
   * (`AZURE_SANDBOX_DISK_IMAGE`). Private disk image resource ID (baked from
   * the Roomote worker OCI image), or `public:<name>` for a public preset
   * (e.g. `public:ubuntu`).
   */
  diskImage: string;
  /**
   * Optional client ID of a user-assigned managed identity
   * (`AZURE_CLIENT_ID`). When unset and no service principal is configured,
   * auth falls back to the ambient Azure credential chain (az login locally,
   * system-assigned identity when deployed).
   */
  managedIdentityClientId?: string;
  /**
   * Service principal credentials (`AZURE_TENANT_ID` + `AZURE_CLIENT_ID` +
   * `AZURE_CLIENT_SECRET`). Preferred for containerized deployments: unlike
   * the ambient chain, these values come through Roomote's resolved-env
   * channel (DB-persisted setup values or process env), not only process env.
   */
  servicePrincipal?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  /**
   * Maximum sandbox lifetime in milliseconds, enforced provider-side via the
   * sandbox auto-delete lifecycle policy.
   */
  timeoutMs?: number;
  /**
   * Idle auto-suspend interval in seconds. Defaults to 0 (disabled): Roomote
   * drives suspend/resume explicitly via standby and idle workers must not
   * suspend underneath the controller.
   */
  autoSuspendSeconds?: number;
  /** CPU request in millicores (default 1000 = 1 vCPU). */
  cpuMillicores?: number;
  /** Memory request in MiB (default 2048). */
  memoryMiB?: number;
  /**
   * Egress proxy TLS inspection mode for new sandboxes. Defaults to
   * `Partial`: Roomote configures no egress rules, and with the service
   * default (`Full`) the proxy TLS-resigns ALL outbound traffic (breaking
   * language-specific trust stores such as Java's cacerts) and blocks
   * non-HTTP traffic (breaking SSH git). Set `Full` when wiring deny-default
   * egress rules or header transforms.
   */
  egressTrafficInspection?: 'Legacy' | 'Full' | 'Partial' | 'None';
  /** Test seam: token provider override (scope `https://dynamicsessions.io/.default`). */
  tokenProvider?: { getToken(): Promise<string> };
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface BlaxelConfig {
  /** Blaxel API key (`BL_API_KEY`). */
  apiKey: string;
  /** Blaxel workspace name (`BL_WORKSPACE`). */
  workspace: string;
  /** Worker-compatible sandbox image (`BLAXEL_IMAGE`). */
  image: string;
  /** Optional Blaxel deployment region (`BLAXEL_REGION`). */
  region?: string;
  /** Sandbox memory allocation in MiB. */
  memoryMiB?: number;
  /** Maximum sandbox lifetime in milliseconds. */
  timeoutMs?: number;
  /** How long a stopped sandbox remains available for task standby resume. */
  standbyTtlMs?: number;
}

export type ComputeProviderFactoryOptions = (
  | {
      provider: 'modal';
      config?: ModalConfig;
    }
  | {
      /**
       * Deployment-managed cloud sandboxes. Runs on the Modal machinery with
       * credentials from `ROOMOTE_CLOUD_TOKEN_ID` / `ROOMOTE_CLOUD_TOKEN_SECRET`
       * instead of the operator's own Modal account.
       */
      provider: 'roomote';
      config?: ModalConfig;
    }
  | {
      provider: 'docker';
      config?: DockerConfig;
    }
  | {
      provider: 'daytona';
      config?: DaytonaConfig;
    }
  | {
      provider: 'e2b';
      config?: E2bConfig;
    }
  | {
      provider: 'blaxel';
      config?: BlaxelConfig;
    }
  | {
      provider: 'azure';
      config?: AzureConfig;
    }
) & {
  /**
   * Pre-resolved env values consulted before `process.env` when a config
   * field is not set explicitly. Lets callers with database access supply
   * deployment env vars saved during setup without mutating `process.env`.
   */
  envFallback?: Partial<Record<string, string>>;
};
