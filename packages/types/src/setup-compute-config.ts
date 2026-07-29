import {
  computeProviders,
  isComputeProvider,
  type ComputeProvider,
} from './compute-providers';

/**
 * How the setup UI treats a compute-provider field:
 * - `credential`: an account credential (token, key) the operator enters
 *   directly for the provider.
 * - `infrastructure`: a deployment worker-image artifact (base image ref,
 *   template id, snapshot name, domain/region). Some infrastructure values are
 *   UI-editable advanced overrides; managed worker artifacts
 *   (`MODAL_BASE_IMAGE_REF`, `E2B_TEMPLATE_ID`, `DAYTONA_SNAPSHOT_NAME`,
 *   `BLAXEL_IMAGE`) are
 *   not operator-edited in the UI — process env, derivation, or detached
 *   provisioning owns them.
 */
export type SetupComputeFieldCategory = 'credential' | 'infrastructure';

export type SetupComputeFieldDescriptor = {
  envVarName: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  /**
   * Distinguishes account credentials from deployment-infrastructure values.
   * Infrastructure fields may be derived, provisioned automatically, or (for
   * optional overrides such as domain/region) saved from the UI.
   */
  category: SetupComputeFieldCategory;
  /**
   * Optional operator-editable infrastructure fields (domain/region) shown with
   * credentials. Managed worker artifacts are never form inputs.
   */
  advanced?: boolean;
  /** Optional presentation and validation metadata for operator inputs. */
  input?: {
    type: 'number';
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
  };
  /** Short guidance displayed with advanced provider settings. */
  helpText?: string;
};

export function getComputeFieldValidationError(
  field: SetupComputeFieldDescriptor,
  value: string,
): string | null {
  if (!field.input || value.length === 0) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return `${field.label} must be a number.`;
  }
  if (field.input.step === 1 && !Number.isInteger(parsed)) {
    return `${field.label} must be a whole number.`;
  }
  if (field.input.min !== undefined && parsed < field.input.min) {
    return `${field.label} must be at least ${field.input.min}.`;
  }
  if (field.input.max !== undefined && parsed > field.input.max) {
    return `${field.label} must be at most ${field.input.max}.`;
  }

  return null;
}

/** True for deployment-infrastructure fields (base images, template ids, snapshot names). */
export function isComputeInfrastructureField(
  field: Pick<SetupComputeFieldDescriptor, 'category'>,
): boolean {
  return field.category === 'infrastructure';
}

/** True for account-credential fields (tokens, API keys). */
export function isComputeCredentialField(
  field: Pick<SetupComputeFieldDescriptor, 'category'>,
): boolean {
  return field.category === 'credential';
}

export type SetupComputeProviderDescriptor = {
  provider: ComputeProvider;
  label: string;
  description: string;
  supportsSnapshots: boolean;
  comment?: string;
  fields: readonly SetupComputeFieldDescriptor[];
};

export type SetupComputeFieldStatus = SetupComputeFieldDescriptor & {
  runtimeSatisfied: boolean;
  savedSatisfied: boolean;
  /** Plain-text value for non-secret fields; secrets never round-trip here. */
  savedValue?: string | null;
  /**
   * True when the deployment can derive a working default for this env-only
   * field without operator input (for example the Modal base image ref from
   * the configured worker image). Derived defaults are persisted server-side
   * when the provider config is saved.
   */
  defaultSatisfied: boolean;
  /**
   * True when this env-only field can be provisioned during setup itself
   * (for example the E2B worker template, which Roomote builds in the
   * operator's E2B account once their API key is saved). Unlike
   * `defaultSatisfied`, provisioning is asynchronous: the field counts
   * toward `infrastructureSatisfied` so the provider stays offered in the
   * picker, but not toward `configSatisfied` — setup only completes once
   * the provisioned value has actually been persisted.
   */
  setupProvisionable: boolean;
};

export type SetupComputeProviderStatus = Omit<
  SetupComputeProviderDescriptor,
  'fields'
> & {
  fields: SetupComputeFieldStatus[];
  runtimeConfigSatisfied: boolean;
  savedConfigSatisfied: boolean;
  configSatisfied: boolean;
  /**
   * True when every required deployment-infrastructure (`envOnly`) field is
   * satisfied by the runtime env, a saved deployment env var, or a derivable
   * default. Providers without that infrastructure are not offered in the
   * setup wizard's provider picker, since the operator cannot satisfy those
   * values from the wizard.
   */
  infrastructureSatisfied: boolean;
};

/**
 * Status of the shared hosted-compute worker image (`DOCKER_WORKER_IMAGE`).
 * Hosted providers (Modal, E2B, Daytona) derive or provision their worker
 * base image from this value, so it is surfaced once, above the provider
 * sections, rather than per provider.
 */
export type SetupComputeWorkerImageStatus = {
  envVarName: typeof SHARED_WORKER_IMAGE_ENV_VAR;
  label: string;
  /** Satisfied by the process env (`DOCKER_WORKER_IMAGE`), which locks the UI field. */
  runtimeSatisfied: boolean;
  /** Satisfied by a saved deployment env var. */
  savedSatisfied: boolean;
  /**
   * The registry-qualified image hosted providers can pull, if one is
   * available (explicit env, saved deployment env var, or the ref derived
   * from the baked `RELEASE_VERSION`). A bare local tag is not hosted-ready.
   */
  hostedImageRef: string | null;
  /** True when a registry-qualified worker image is available for hosted providers. */
  hostedReady: boolean;
};

export type SetupComputeStatus = {
  selectedProvider: ComputeProvider | null;
  preselectedProvider: ComputeProvider;
  runtimeDefaultProvider: ComputeProvider | null;
  persistedDefaultProvider: ComputeProvider | null;
  providers: SetupComputeProviderStatus[];
  workerImage: SetupComputeWorkerImageStatus;
  setupSatisfied: boolean;
  excludedProviders?: ComputeProvider[];
  /** True when any hosted provider is fully configured in the process env. */
  setupSatisfiedByRuntimeEnv: boolean;
};

export type DeploymentComputeConfig = {
  defaultProvider: ComputeProvider | null;
  excludedProviders: ComputeProvider[];
};

export const SETUP_COMPUTE_PROVIDER_IDS = computeProviders;

export const DEFAULT_SETUP_COMPUTE_PROVIDER_ID: ComputeProvider = 'docker';

export const DEFAULT_LOCAL_DOCKER_WORKER_IMAGE = 'roomote-worker:local';

/**
 * Shared hosted-compute worker image env var. Hosted providers derive or
 * provision their worker base image from this value, so it is configured
 * once for the whole deployment rather than per provider.
 */
export const SHARED_WORKER_IMAGE_ENV_VAR = 'DOCKER_WORKER_IMAGE';

export function parseExcludedComputeProviders(
  value: string | null | undefined,
): Set<ComputeProvider> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(isComputeProvider),
  );
}

/**
 * Preferring a configured cloud provider over Local Docker when both are
 * available. When multiple clouds are available, prefer the last one in
 * setup-catalog order (latest cloud option among those that are ready).
 */
export function pickPreferredConfiguredComputeProvider(
  providers: readonly ComputeProvider[],
): ComputeProvider | undefined {
  if (providers.length === 0) {
    return undefined;
  }

  const available = new Set(providers);
  const catalogOrdered = SETUP_COMPUTE_PROVIDER_CATALOG.map(
    (descriptor) => descriptor.provider,
  ).filter((provider) => available.has(provider));
  const cloudProviders = catalogOrdered.filter(
    (provider) => provider !== DEFAULT_SETUP_COMPUTE_PROVIDER_ID,
  );

  if (cloudProviders.length > 0) {
    return cloudProviders[cloudProviders.length - 1];
  }

  return catalogOrdered[0];
}

export function getDefaultAvailableComputeProvider(
  excludedProviders: ReadonlySet<ComputeProvider> = new Set(),
  availableProviders?: Iterable<{
    provider: ComputeProvider;
    configSatisfied: boolean;
  }>,
): ComputeProvider {
  if (availableProviders !== undefined) {
    const satisfiedProviders = Array.from(availableProviders)
      .filter(
        (provider) =>
          !excludedProviders.has(provider.provider) &&
          provider.configSatisfied !== false,
      )
      .map((provider) => provider.provider);

    const preferred =
      pickPreferredConfiguredComputeProvider(satisfiedProviders);
    if (preferred) {
      return preferred;
    }

    // Nothing reported as ready (or everything excluded from the live set):
    // keep Local Docker as the last-resort default id even when excluded from
    // the operator-facing catalog.
    return DEFAULT_SETUP_COMPUTE_PROVIDER_ID;
  }

  if (!excludedProviders.has(DEFAULT_SETUP_COMPUTE_PROVIDER_ID)) {
    // No live readiness: Local Docker is the barrier default for setup when
    // it is still allowed. Callers that know which providers are configured
    // pass `availableProviders` so cloud can outrank docker.
    return DEFAULT_SETUP_COMPUTE_PROVIDER_ID;
  }

  // Docker excluded and no live readiness: first catalog entry that could be
  // operator-configured.
  return (
    SETUP_COMPUTE_PROVIDER_CATALOG.find(
      (provider) =>
        !excludedProviders.has(provider.provider) &&
        provider.fields.some(isComputeOperatorEditableField),
    )?.provider ?? DEFAULT_SETUP_COMPUTE_PROVIDER_ID
  );
}

export const SETUP_COMPUTE_PROVIDER_CATALOG = [
  {
    provider: 'roomote',
    label: 'Roomote Cloud',
    description:
      'Managed sandboxes preconfigured by your deployment, with snapshot support. Nothing to set up.',
    supportsSnapshots: true,
    fields: [
      {
        // Deployment-managed credentials: seeded into the process env by the
        // hosting operator, never collected from the setup/Settings UI. When
        // they are absent the provider is not offered in the picker
        // (infrastructureSatisfied is false). The id stays required while
        // Modal is the only backend — it rejects launches without it, so a
        // secret-only deployment must not read as configured. Future API-key
        // backends (which use only the secret slot) should make this
        // requiredness backend-aware rather than dropping it outright.
        envVarName: 'ROOMOTE_CLOUD_TOKEN_ID',
        label: 'Roomote Cloud Token ID',
        category: 'infrastructure',
      },
      {
        envVarName: 'ROOMOTE_CLOUD_TOKEN_SECRET',
        label: 'Roomote Cloud Token Secret',
        secret: true,
        category: 'infrastructure',
      },
      {
        // Selects the engine backing the managed provider (default modal).
        // See ROOMOTE_CLOUD_BACKENDS in compute-providers/roomote-cloud.ts.
        envVarName: 'ROOMOTE_CLOUD_BACKEND',
        label: 'Roomote Cloud Backend',
        required: false,
        category: 'infrastructure',
      },
      {
        // Engine-neutral deployment identity; backends map it to their
        // native grouping (Modal app name) for per-deployment attribution.
        envVarName: 'ROOMOTE_CLOUD_SLUG',
        label: 'Roomote Cloud Slug',
        required: false,
        category: 'infrastructure',
      },
      {
        // Managed app-name override; deliberately separate from
        // MODAL_APP_NAME so bring-your-own Modal settings cannot redirect
        // managed-provider attribution.
        envVarName: 'ROOMOTE_CLOUD_APP_NAME',
        label: 'Roomote Cloud App Name',
        required: false,
        category: 'infrastructure',
      },
      {
        // Compute broker base URL for the `broker` backend. Seeded by the
        // hosting operator's provisioning alongside the token pair.
        envVarName: 'ROOMOTE_CLOUD_BROKER_URL',
        label: 'Roomote Cloud Broker URL',
        required: false,
        category: 'infrastructure',
      },
      {
        // Shared with the Modal provider: the default backend runs on Modal,
        // and the base image derives from the deployment's worker image.
        envVarName: 'MODAL_BASE_IMAGE_REF',
        label: 'Base Image Reference',
        category: 'infrastructure',
      },
    ],
  },
  {
    provider: 'modal',
    label: 'Modal',
    description:
      'Hosted Modal sandboxes with snapshot support. Requires a Modal token pair.',
    supportsSnapshots: true,
    fields: [
      {
        envVarName: 'MODAL_TOKEN_ID',
        label: 'Modal Token ID',
        category: 'credential',
      },
      {
        envVarName: 'MODAL_TOKEN_SECRET',
        label: 'Modal Token Secret',
        secret: true,
        category: 'credential',
      },
      {
        // Derived from the worker image (or process env); not a Settings/setup
        // form input — matches E2B template / Daytona snapshot treatment.
        envVarName: 'MODAL_BASE_IMAGE_REF',
        label: 'Base Image Reference',
        category: 'infrastructure',
      },
      {
        envVarName: 'MODAL_REGIONS',
        label: 'Modal Regions',
        required: false,
        secret: false,
        category: 'infrastructure',
        advanced: true,
      },
    ],
  },
  {
    provider: 'e2b',
    label: 'E2B',
    description:
      'Hosted E2B sandboxes with snapshot support and API-key-only onboarding.',
    supportsSnapshots: true,
    fields: [
      {
        envVarName: 'E2B_API_KEY',
        label: 'E2B API Key',
        secret: true,
        category: 'credential',
      },
      {
        // Auto-provisioned (or process-env); not shown as a Settings/setup input.
        envVarName: 'E2B_TEMPLATE_ID',
        label: 'Worker Template ID',
        category: 'infrastructure',
      },
      {
        envVarName: 'E2B_DOMAIN',
        label: 'E2B Domain',
        required: false,
        category: 'infrastructure',
        advanced: true,
      },
    ],
  },
  {
    provider: 'daytona',
    label: 'Daytona',
    description:
      'Hosted Daytona sandboxes with snapshot support and API-key-only onboarding.',
    supportsSnapshots: true,
    fields: [
      {
        envVarName: 'DAYTONA_API_KEY',
        label: 'Daytona API Key',
        secret: true,
        category: 'credential',
      },
      {
        // Auto-provisioned (or process-env); not shown as a Settings/setup input.
        envVarName: 'DAYTONA_SNAPSHOT_NAME',
        label: 'Worker Snapshot Name',
        category: 'infrastructure',
      },
      {
        envVarName: 'DAYTONA_API_URL',
        label: 'Daytona API URL',
        required: false,
        category: 'infrastructure',
        advanced: true,
      },
      {
        envVarName: 'DAYTONA_TARGET',
        label: 'Daytona Region',
        required: false,
        category: 'infrastructure',
        advanced: true,
      },
    ],
  },
  {
    provider: 'blaxel',
    label: 'Blaxel',
    description:
      'Hosted Blaxel sandboxes with bounded standby retention and fast resume.',
    supportsSnapshots: false,
    fields: [
      {
        envVarName: 'BL_API_KEY',
        label: 'Blaxel API Key',
        secret: true,
        category: 'credential',
      },
      {
        envVarName: 'BL_WORKSPACE',
        label: 'Blaxel Workspace',
        category: 'credential',
      },
      {
        envVarName: 'BLAXEL_IMAGE',
        label: 'Worker Image',
        category: 'infrastructure',
      },
      {
        envVarName: 'BLAXEL_REGION',
        label: 'Blaxel Region',
        required: false,
        category: 'infrastructure',
        advanced: true,
      },
      {
        envVarName: 'BLAXEL_STANDBY_MAX_COUNT',
        label: 'Maximum retained tasks',
        required: false,
        category: 'infrastructure',
        advanced: true,
        input: { type: 'number', min: 0, step: 1, placeholder: '25' },
        helpText: 'Defaults to 25. Set to 0 to disable standby retention.',
      },
      {
        envVarName: 'BLAXEL_STANDBY_MAX_AGE_HOURS',
        label: 'Retention period (hours)',
        required: false,
        category: 'infrastructure',
        advanced: true,
        input: {
          type: 'number',
          min: 1,
          max: 168,
          step: 1,
          placeholder: '168',
        },
        helpText:
          'Defaults to 168 hours (7 days), Blaxel’s maximum standby TTL.',
      },
    ],
  },
  {
    provider: 'azure',
    label: 'Azure Container Apps',
    description:
      'Azure Container Apps sandboxes (preview) with memory+disk snapshots and sub-second suspend/resume standby. Auth uses the ambient Azure login (az) or a managed identity — no API key. Requires an Azure sandbox group.',
    supportsSnapshots: true,
    fields: [
      {
        envVarName: 'AZURE_SUBSCRIPTION_ID',
        label: 'Azure Subscription ID',
        category: 'credential',
      },
      {
        envVarName: 'AZURE_RESOURCE_GROUP',
        label: 'Azure Resource Group',
        category: 'credential',
      },
      {
        envVarName: 'AZURE_SANDBOX_GROUP',
        label: 'Sandbox Group Name',
        category: 'credential',
      },
      {
        envVarName: 'AZURE_SANDBOX_REGION',
        label: 'Sandbox Region',
        category: 'credential',
      },
      {
        // Provisioned by baking the Roomote worker OCI image into a sandbox
        // disk image (or process env); not a Settings/setup form input.
        envVarName: 'AZURE_SANDBOX_DISK_IMAGE',
        label: 'Worker Disk Image',
        category: 'infrastructure',
      },
      {
        // Optional user-assigned managed identity client id for Azure-hosted
        // controllers — OR the service principal's client (app) id when paired
        // with AZURE_TENANT_ID + AZURE_CLIENT_SECRET. Omit both paths to use
        // az-login (local) or the system-assigned identity (deployed).
        envVarName: 'AZURE_CLIENT_ID',
        label: 'Managed Identity / Service Principal Client ID',
        required: false,
        category: 'credential',
        advanced: true,
      },
      {
        // Service principal auth for containerized/headless deployments where
        // az login is impractical: all three SP values must be set together.
        envVarName: 'AZURE_TENANT_ID',
        label: 'Service Principal Tenant ID',
        required: false,
        category: 'credential',
        advanced: true,
      },
      {
        envVarName: 'AZURE_CLIENT_SECRET',
        label: 'Service Principal Client Secret',
        required: false,
        secret: true,
        category: 'credential',
        advanced: true,
      },
      {
        // Pull credentials for baking the worker disk image from a private
        // registry (GHCR: token owner's GitHub username + PAT with
        // read:packages). Only needed when the worker image is not public.
        envVarName: 'AZURE_SANDBOX_REGISTRY_USERNAME',
        label: 'Worker Registry Username',
        required: false,
        category: 'infrastructure',
        advanced: true,
      },
      {
        envVarName: 'AZURE_SANDBOX_REGISTRY_TOKEN',
        label: 'Worker Registry Token',
        required: false,
        secret: true,
        category: 'infrastructure',
        advanced: true,
      },
    ],
  },
  {
    provider: 'docker',
    label: 'Local Docker',
    comment: 'Run on this host',
    description:
      'Runs each task in a Docker container on the host with bounded stopped-container resume. No credentials needed, but the controller must have access to the Docker socket and tasks share the host with Roomote itself.',
    supportsSnapshots: false,
    fields: [
      {
        envVarName: 'DOCKER_STANDBY_MAX_COUNT',
        label: 'Maximum retained tasks',
        required: false,
        category: 'infrastructure',
        advanced: true,
        input: { type: 'number', min: 0, step: 1, placeholder: '10' },
        helpText: 'Defaults to 10. Set to 0 to disable standby retention.',
      },
      {
        envVarName: 'DOCKER_STANDBY_MAX_AGE_HOURS',
        label: 'Retention period (hours)',
        required: false,
        category: 'infrastructure',
        advanced: true,
        input: {
          type: 'number',
          min: 1,
          max: 168,
          step: 1,
          placeholder: '24',
        },
        helpText: 'Defaults to 24 hours.',
      },
    ],
  },
] as const satisfies readonly SetupComputeProviderDescriptor[];

/**
 * Sandbox-provider env vars managed by the setup flow and the Settings →
 * Sandboxes page: account credentials, provider-specific infrastructure values
 * (base images, template ids, snapshot names), and the shared worker image.
 * Template IDs / snapshot names are reserved for process env + auto-
 * provisioning rather than operator form inputs; they are still reserved from
 * the generic environment-variables editor.
 */
export const COMPUTE_PROVIDER_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  SHARED_WORKER_IMAGE_ENV_VAR,
  ...(
    SETUP_COMPUTE_PROVIDER_CATALOG as readonly SetupComputeProviderDescriptor[]
  ).flatMap((descriptor) => descriptor.fields.map((field) => field.envVarName)),
]);

export const NON_SECRET_COMPUTE_ENV_VAR_NAMES: readonly string[] = (
  SETUP_COMPUTE_PROVIDER_CATALOG as readonly SetupComputeProviderDescriptor[]
).flatMap((descriptor) =>
  descriptor.fields
    .filter((field) => field.secret !== true)
    .map((field) => field.envVarName),
);

function isSecretSetupComputeField(
  field: Pick<SetupComputeFieldDescriptor, 'secret'>,
): boolean {
  return field.secret === true;
}

/**
 * Env-only infrastructure values that the deployment can provision itself
 * during setup (see the compute-provisioning command module in apps/web).
 * These are not operator form inputs in Settings/setup — process env or
 * detached provisioning owns them.
 */
const SETUP_PROVISIONABLE_COMPUTE_ENV_VARS: ReadonlySet<string> = new Set([
  'E2B_TEMPLATE_ID',
  'DAYTONA_SNAPSHOT_NAME',
  'BLAXEL_IMAGE',
  'AZURE_SANDBOX_DISK_IMAGE',
]);

/**
 * True for provider worker artifacts Roomote builds/registers itself
 * (`E2B_TEMPLATE_ID`, `DAYTONA_SNAPSHOT_NAME`, `BLAXEL_IMAGE`). These are not Settings/setup
 * UI inputs: operators satisfy them via process env or auto-provisioning
 * after credentials + a registry-qualified worker image are available.
 */
export function isAutoProvisionedComputeArtifactField(
  field: Pick<SetupComputeFieldDescriptor, 'envVarName'>,
): boolean {
  return SETUP_PROVISIONABLE_COMPUTE_ENV_VARS.has(field.envVarName);
}

/**
 * Deployment-managed credential env vars (Roomote Cloud) that only the
 * hosting operator's provisioning sets. Never operator form inputs.
 */
const DEPLOYMENT_MANAGED_COMPUTE_ENV_VARS: ReadonlySet<string> = new Set([
  'ROOMOTE_CLOUD_TOKEN_ID',
  'ROOMOTE_CLOUD_TOKEN_SECRET',
  'ROOMOTE_CLOUD_BACKEND',
  'ROOMOTE_CLOUD_SLUG',
  'ROOMOTE_CLOUD_APP_NAME',
  'ROOMOTE_CLOUD_BROKER_URL',
]);

/**
 * True for managed Modal / E2B / Daytona / Blaxel worker-image artifact env vars that
 * Settings and setup never collect as form inputs. Process env, derivation
 * from DOCKER_WORKER_IMAGE / RELEASE_VERSION, or detached provisioning owns
 * them. Deployment-managed Roomote Cloud credentials are included: the
 * hosting operator's provisioning owns them.
 */
export function isManagedComputeArtifactField(
  field: Pick<SetupComputeFieldDescriptor, 'envVarName'>,
): boolean {
  return (
    isAutoProvisionedComputeArtifactField(field) ||
    field.envVarName === 'MODAL_BASE_IMAGE_REF' ||
    DEPLOYMENT_MANAGED_COMPUTE_ENV_VARS.has(field.envVarName)
  );
}

/**
 * True for fields the sandboxes UI and setup wizard may collect from an
 * operator. Managed worker artifacts are excluded.
 */
export function isComputeOperatorEditableField(
  field: Pick<SetupComputeFieldDescriptor, 'envVarName'>,
): boolean {
  return !isManagedComputeArtifactField(field);
}

const SETUP_COMPUTE_PROVIDER_BY_ID = new Map<
  ComputeProvider,
  SetupComputeProviderDescriptor
>(
  SETUP_COMPUTE_PROVIDER_CATALOG.map((descriptor) => [
    descriptor.provider,
    descriptor,
  ]),
);

const DEFAULT_SETUP_COMPUTE_PROVIDER_DESCRIPTOR: SetupComputeProviderDescriptor =
  SETUP_COMPUTE_PROVIDER_CATALOG.find(
    (descriptor) => descriptor.provider === DEFAULT_SETUP_COMPUTE_PROVIDER_ID,
  )!;

export function getSetupComputeProvider(
  provider: ComputeProvider,
): SetupComputeProviderDescriptor {
  return (
    SETUP_COMPUTE_PROVIDER_BY_ID.get(provider) ??
    DEFAULT_SETUP_COMPUTE_PROVIDER_DESCRIPTOR
  );
}

export function isRequiredComputeField(field: SetupComputeFieldDescriptor) {
  return field.required !== false;
}

export function createEmptyDeploymentComputeConfig(): DeploymentComputeConfig {
  return {
    defaultProvider: null,
    excludedProviders: [],
  };
}

export function normalizeDeploymentComputeConfig(
  value: Partial<DeploymentComputeConfig> | null | undefined,
): DeploymentComputeConfig {
  const defaultProvider = value?.defaultProvider;

  return {
    defaultProvider:
      defaultProvider && isComputeProvider(defaultProvider)
        ? defaultProvider
        : null,
    excludedProviders: Array.from(
      new Set((value?.excludedProviders ?? []).filter(isComputeProvider)),
    ),
  };
}

function isConfiguredEnvValue(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Registry repository the publish workflow pushes the worker image to, in
 * lockstep with the app image: both are tagged with the same version, which
 * the app image also bakes as the RELEASE_VERSION env var.
 */
const DEFAULT_WORKER_IMAGE_REPOSITORY = 'ghcr.io/roocodeinc/roomote-worker';

// Source checkouts do not have a baked RELEASE_VERSION. Follow the published
// development channel automatically for hosted providers; operators can pin
// any registry-qualified image with DOCKER_WORKER_IMAGE.
export const DEVELOPMENT_MODAL_BASE_IMAGE_REF =
  'ghcr.io/roocodeinc/roomote-worker:develop';

const ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF =
  'ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF';

/**
 * Derives the published worker image ref for the running app release:
 * `<repo>:${RELEASE_VERSION}`, where the repo defaults to the official GHCR
 * repository and can be overridden with ROOMOTE_WORKER_IMAGE_REPO (for forks
 * or registry mirrors). Returns null for local builds, where RELEASE_VERSION
 * is unset or a `self-host*` placeholder and no matching published tag
 * exists.
 */
export function deriveWorkerImageFromReleaseVersion(
  runtimeEnv: Partial<Record<string, string | undefined>>,
): string | null {
  const version = runtimeEnv.RELEASE_VERSION?.trim();

  if (!version || version === 'self-host' || version.startsWith('self-host-')) {
    return null;
  }

  const repository =
    runtimeEnv.ROOMOTE_WORKER_IMAGE_REPO?.trim() ||
    DEFAULT_WORKER_IMAGE_REPOSITORY;

  return `${repository}:${version}`;
}

/**
 * The worker image the deployment effectively uses: an explicit
 * DOCKER_WORKER_IMAGE always wins; otherwise the ref derived from the baked
 * RELEASE_VERSION. Null when neither is available (local dev, where the
 * bare local-worker fallback applies at the env-loader layer).
 */
export function resolveEffectiveDockerWorkerImage(
  runtimeEnv: Partial<Record<string, string | undefined>>,
): string | null {
  const explicit = runtimeEnv.DOCKER_WORKER_IMAGE?.trim();

  if (explicit) {
    return explicit;
  }

  return deriveWorkerImageFromReleaseVersion(runtimeEnv);
}

function isDevelopmentRuntime(
  runtimeEnv: Partial<Record<string, string | undefined>>,
): boolean {
  return (
    runtimeEnv.APP_ENV?.trim() === 'development' ||
    runtimeEnv.NODE_ENV?.trim() === 'development'
  );
}

/**
 * Canonical Modal base-image default derived from the deployment's effective
 * worker image. This keeps every caller aligned on the same release-version
 * and local-tag handling as `resolveEffectiveDockerWorkerImage`.
 */
export function resolveDerivedModalBaseImageRef(
  runtimeEnv: Partial<Record<string, string | undefined>>,
): string | null {
  const derivedFromWorkerImage = deriveModalBaseImageRefDefault(
    resolveEffectiveDockerWorkerImage(runtimeEnv),
  );

  if (derivedFromWorkerImage) {
    return derivedFromWorkerImage;
  }

  if (!isDevelopmentRuntime(runtimeEnv)) {
    return null;
  }

  return (
    runtimeEnv[ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF]?.trim() ||
    DEVELOPMENT_MODAL_BASE_IMAGE_REF
  );
}

/**
 * Modal base image resolution for callers that want the runtime env value when
 * present, otherwise the canonical derived default.
 */
export function resolveEffectiveModalBaseImageRef(
  runtimeEnv: Partial<Record<string, string | undefined>>,
): string | null {
  const explicit = runtimeEnv.MODAL_BASE_IMAGE_REF?.trim();

  if (explicit) {
    return explicit;
  }

  return resolveDerivedModalBaseImageRef(runtimeEnv);
}

/**
 * Derives a default Modal worker base image ref from the configured Docker
 * worker image. The published worker image doubles as the Modal base image
 * (the installer and deployer already rely on that equivalence when they
 * manage MODAL_BASE_IMAGE_REF), but only registry-qualified refs are safe
 * defaults: a bare local tag such as `roomote-worker:local` is not pullable
 * by Modal.
 */
export function deriveModalBaseImageRefDefault(
  dockerWorkerImage: string | null | undefined,
): string | null {
  const trimmed = dockerWorkerImage?.trim() ?? '';

  if (!trimmed || !trimmed.includes('/')) {
    return null;
  }

  return trimmed;
}

export function buildSetupComputeStatus(input: {
  runtimeEnv?: Partial<Record<string, string | undefined>> | null;
  persistedEnvVarNames?: Iterable<string>;
  persistedEnvVarValues?: Partial<Record<string, string>>;
  persistedComputeConfig?: Partial<DeploymentComputeConfig> | null;
  selectedProvider?: ComputeProvider | null;
  /**
   * Raw saved deployment `DOCKER_WORKER_IMAGE` value, when the caller has
   * resolved it. Process env still wins; this lets a worker image saved
   * through the UI count toward hosted readiness before the process restarts.
   */
  savedWorkerImage?: string | null;
}): SetupComputeStatus {
  const runtimeEnv = input.runtimeEnv ?? {};
  const persistedEnvVarNameSet = new Set(
    Array.from(input.persistedEnvVarNames ?? []).map((name) => name.trim()),
  );
  const persistedEnvVarValues = input.persistedEnvVarValues ?? {};
  const persistedComputeConfig = normalizeDeploymentComputeConfig(
    input.persistedComputeConfig,
  );

  const runtimeDefaultValue = runtimeEnv.DEFAULT_COMPUTE_PROVIDER?.trim();
  const excludedProviders = parseExcludedComputeProviders(
    runtimeEnv.EXCLUDED_COMPUTE_PROVIDERS,
  );
  for (const provider of persistedComputeConfig.excludedProviders) {
    excludedProviders.add(provider);
  }
  const runtimeDefaultProvider =
    runtimeDefaultValue &&
    isComputeProvider(runtimeDefaultValue) &&
    !excludedProviders.has(runtimeDefaultValue)
      ? runtimeDefaultValue
      : null;

  // Worker image resolution is deploy/runtime-managed only: process env wins,
  // then the ref derived from the baked RELEASE_VERSION. Legacy saved
  // deployment DOCKER_WORKER_IMAGE rows (from the removed Settings section)
  // are ignored so they cannot stick above release-derived images. Only a
  // registry-qualified ref is hosted-ready; a bare local tag is not pullable
  // by hosted providers.
  const hostedWorkerImageRef = resolveDerivedModalBaseImageRef(runtimeEnv);
  const derivedModalBaseImageRef = hostedWorkerImageRef;

  const workerImage: SetupComputeWorkerImageStatus = {
    envVarName: SHARED_WORKER_IMAGE_ENV_VAR,
    label: 'Worker image',
    runtimeSatisfied: isConfiguredEnvValue(runtimeEnv.DOCKER_WORKER_IMAGE),
    // Legacy DB-backed worker images are no longer part of readiness/status.
    savedSatisfied: false,
    hostedImageRef: hostedWorkerImageRef,
    hostedReady: hostedWorkerImageRef !== null,
  };

  const providers = SETUP_COMPUTE_PROVIDER_CATALOG.map((descriptor) => {
    const fields: SetupComputeFieldStatus[] = (
      descriptor.fields as readonly SetupComputeFieldDescriptor[]
    ).map((field) => {
      const runtimeValue = runtimeEnv[field.envVarName]?.trim() || null;
      const persistedValue =
        persistedEnvVarValues[field.envVarName]?.trim() || null;
      const savedValue = isSecretSetupComputeField(field)
        ? null
        : (runtimeValue ?? persistedValue);

      return {
        ...field,
        runtimeSatisfied: isConfiguredEnvValue(runtimeEnv[field.envVarName]),
        savedSatisfied: persistedEnvVarNameSet.has(field.envVarName),
        savedValue,
        defaultSatisfied:
          field.envVarName === 'MODAL_BASE_IMAGE_REF' &&
          derivedModalBaseImageRef !== null,
        // The E2B worker template and the Daytona worker snapshot are
        // provisionable during setup whenever a registry-qualified worker
        // image is configured; the run happens in the operator's provider
        // account after their credentials are saved.
        setupProvisionable:
          SETUP_PROVISIONABLE_COMPUTE_ENV_VARS.has(field.envVarName) &&
          derivedModalBaseImageRef !== null,
      };
    });

    const requiredFields = fields.filter(isRequiredComputeField);
    const runtimeConfigSatisfied = requiredFields.every(
      (field) => field.runtimeSatisfied,
    );
    const savedConfigSatisfied = requiredFields.every(
      (field) => field.savedSatisfied,
    );
    const configSatisfied = requiredFields.every(
      (field) =>
        field.runtimeSatisfied ||
        field.savedSatisfied ||
        field.defaultSatisfied,
    );
    const infrastructureSatisfied = requiredFields
      .filter((field) => isComputeInfrastructureField(field))
      .every(
        (field) =>
          field.runtimeSatisfied ||
          field.savedSatisfied ||
          field.defaultSatisfied ||
          field.setupProvisionable,
      );

    return {
      ...descriptor,
      fields,
      runtimeConfigSatisfied,
      savedConfigSatisfied,
      configSatisfied,
      infrastructureSatisfied,
    };
  });

  const selectedProvider =
    input.selectedProvider && !excludedProviders.has(input.selectedProvider)
      ? input.selectedProvider
      : persistedComputeConfig.defaultProvider &&
          !excludedProviders.has(persistedComputeConfig.defaultProvider)
        ? persistedComputeConfig.defaultProvider
        : null;
  const providerReadiness = providers.map((provider) => ({
    provider: provider.provider,
    configSatisfied: provider.configSatisfied,
  }));
  const configuredCloudReady = providers.some(
    (provider) =>
      provider.provider !== DEFAULT_SETUP_COMPUTE_PROVIDER_ID &&
      provider.configSatisfied &&
      !excludedProviders.has(provider.provider),
  );
  // Compose stacks often inject DEFAULT_COMPUTE_PROVIDER=docker. When a cloud
  // provider is already configured, ignore that barrier default for preselect.
  const effectiveRuntimeDefaultProvider =
    runtimeDefaultProvider === DEFAULT_SETUP_COMPUTE_PROVIDER_ID &&
    configuredCloudReady
      ? null
      : runtimeDefaultProvider;
  const preselectedProvider =
    selectedProvider ??
    effectiveRuntimeDefaultProvider ??
    getDefaultAvailableComputeProvider(excludedProviders, providerReadiness);

  const selectedProviderStatus = selectedProvider
    ? providers.find((candidate) => candidate.provider === selectedProvider)
    : null;
  const setupSatisfiedByRuntimeEnv = providers.some(
    (provider) =>
      provider.provider !== DEFAULT_SETUP_COMPUTE_PROVIDER_ID &&
      provider.fields
        .filter(isRequiredComputeField)
        .every((field) => field.runtimeSatisfied || field.defaultSatisfied),
  );
  const setupSatisfied =
    setupSatisfiedByRuntimeEnv ||
    (selectedProvider !== null &&
      (selectedProviderStatus?.configSatisfied ?? false));

  return {
    selectedProvider,
    preselectedProvider,
    runtimeDefaultProvider,
    persistedDefaultProvider:
      persistedComputeConfig.defaultProvider &&
      !excludedProviders.has(persistedComputeConfig.defaultProvider)
        ? persistedComputeConfig.defaultProvider
        : null,
    providers,
    workerImage,
    setupSatisfied,
    excludedProviders: Array.from(excludedProviders),
    setupSatisfiedByRuntimeEnv,
  };
}
