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
 *   template id, snapshot name). Infrastructure values are UI-editable, but
 *   they are usually derived from the shared worker image or provisioned
 *   automatically, so they are surfaced as advanced overrides rather than
 *   primary inputs.
 */
export type SetupComputeFieldCategory = 'credential' | 'infrastructure';

export type SetupComputeFieldDescriptor = {
  envVarName: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  /**
   * Distinguishes account credentials from deployment-infrastructure values.
   * Infrastructure fields (base images, template ids, snapshot names) can be
   * saved from the UI, derived, or provisioned automatically.
   */
  category: SetupComputeFieldCategory;
  /**
   * Provider-specific infrastructure fields shown behind an "Advanced
   * infrastructure" area in the UI, because a sensible value is usually
   * derived from the shared worker image or provisioned automatically.
   */
  advanced?: boolean;
};

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
};

export type DeploymentComputeConfig = {
  defaultProvider: ComputeProvider | null;
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

export function getDefaultAvailableComputeProvider(
  excludedProviders: ReadonlySet<ComputeProvider> = new Set(),
  availableProviders?: Iterable<{
    provider: ComputeProvider;
    configSatisfied: boolean;
  }>,
): ComputeProvider {
  if (!excludedProviders.has(DEFAULT_SETUP_COMPUTE_PROVIDER_ID)) {
    return DEFAULT_SETUP_COMPUTE_PROVIDER_ID;
  }

  return (
    Array.from(
      availableProviders ??
        SETUP_COMPUTE_PROVIDER_CATALOG.map((provider) => ({
          provider: provider.provider,
          configSatisfied: true,
        })),
    ).find(
      (provider) =>
        !excludedProviders.has(provider.provider) &&
        provider.configSatisfied !== false,
    )?.provider ?? DEFAULT_SETUP_COMPUTE_PROVIDER_ID
  );
}

export const SETUP_COMPUTE_PROVIDER_CATALOG = [
  {
    provider: 'modal',
    label: 'Modal',
    description:
      'Hosted Modal sandboxes with snapshot support. Requires a Modal token pair.',
    supportsSnapshots: true,
    comment: 'Recommended',
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
        envVarName: 'MODAL_BASE_IMAGE_REF',
        label: 'Base Image Reference',
        category: 'infrastructure',
        advanced: true,
      },
      {
        envVarName: 'MODAL_REGIONS',
        label: 'Modal Regions',
        required: false,
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
    comment: 'Recommended',
    fields: [
      {
        envVarName: 'E2B_API_KEY',
        label: 'E2B API Key',
        secret: true,
        category: 'credential',
      },
      {
        envVarName: 'E2B_TEMPLATE_ID',
        label: 'Worker Template ID',
        category: 'infrastructure',
        advanced: true,
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
      'Hosted Daytona sandboxes with API-key-only onboarding. Does not support environment snapshots yet.',
    supportsSnapshots: false,
    fields: [
      {
        envVarName: 'DAYTONA_API_KEY',
        label: 'Daytona API Key',
        secret: true,
        category: 'credential',
      },
      {
        envVarName: 'DAYTONA_SNAPSHOT_NAME',
        label: 'Worker Snapshot Name',
        category: 'infrastructure',
        advanced: true,
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
    provider: 'docker',
    label: 'Local Docker',
    comment: 'Run on this host',
    description:
      'Runs each task in a Docker container on the host. No credentials needed, but the controller must have access to the Docker socket and tasks share the host with Roomote itself. No snapshot support.',
    supportsSnapshots: false,
    fields: [],
  },
] as const satisfies readonly SetupComputeProviderDescriptor[];

/**
 * Compute-provider env vars managed by the setup flow and the Settings →
 * Compute page: account credentials, provider-specific infrastructure values
 * (base images, template ids, snapshot names), and the shared worker image.
 * They are reserved from the generic environment-variables editor so operators
 * configure them through the compute UI (or the deployment env) instead.
 */
export const COMPUTE_PROVIDER_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  SHARED_WORKER_IMAGE_ENV_VAR,
  ...(
    SETUP_COMPUTE_PROVIDER_CATALOG as readonly SetupComputeProviderDescriptor[]
  ).flatMap((descriptor) => descriptor.fields.map((field) => field.envVarName)),
]);

/**
 * Env-only infrastructure values that the deployment can provision itself
 * during setup (see the compute-provisioning command module in apps/web).
 */
const SETUP_PROVISIONABLE_COMPUTE_ENV_VARS: ReadonlySet<string> = new Set([
  'E2B_TEMPLATE_ID',
  'DAYTONA_SNAPSHOT_NAME',
]);

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

export const DEVELOPMENT_MODAL_BASE_IMAGE_REF =
  'ghcr.io/roocodeinc/roomote-worker:latest';

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

  return isDevelopmentRuntime(runtimeEnv)
    ? DEVELOPMENT_MODAL_BASE_IMAGE_REF
    : null;
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
  const persistedComputeConfig = normalizeDeploymentComputeConfig(
    input.persistedComputeConfig,
  );

  const runtimeDefaultValue = runtimeEnv.DEFAULT_COMPUTE_PROVIDER?.trim();
  const excludedProviders = parseExcludedComputeProviders(
    runtimeEnv.EXCLUDED_COMPUTE_PROVIDERS,
  );
  const runtimeDefaultProvider =
    runtimeDefaultValue &&
    isComputeProvider(runtimeDefaultValue) &&
    !excludedProviders.has(runtimeDefaultValue)
      ? runtimeDefaultValue
      : null;

  // Worker image resolution follows the runtime precedence: an explicit
  // process env value wins, then a saved deployment env var, then the ref
  // derived from the baked RELEASE_VERSION. Only a registry-qualified ref is
  // hosted-ready; a bare local tag is not pullable by hosted providers.
  const explicitWorkerImage = runtimeEnv.DOCKER_WORKER_IMAGE?.trim() || null;
  const savedWorkerImage = input.savedWorkerImage?.trim() || null;
  const effectiveWorkerImage =
    explicitWorkerImage ??
    savedWorkerImage ??
    deriveWorkerImageFromReleaseVersion(runtimeEnv);
  const hostedWorkerImageRef =
    deriveModalBaseImageRefDefault(effectiveWorkerImage) ??
    (isDevelopmentRuntime(runtimeEnv)
      ? DEVELOPMENT_MODAL_BASE_IMAGE_REF
      : null);
  const derivedModalBaseImageRef = hostedWorkerImageRef;

  const workerImage: SetupComputeWorkerImageStatus = {
    envVarName: SHARED_WORKER_IMAGE_ENV_VAR,
    label: 'Worker image',
    runtimeSatisfied: isConfiguredEnvValue(runtimeEnv.DOCKER_WORKER_IMAGE),
    savedSatisfied: persistedEnvVarNameSet.has(SHARED_WORKER_IMAGE_ENV_VAR),
    hostedImageRef: hostedWorkerImageRef,
    hostedReady: hostedWorkerImageRef !== null,
  };

  const providers = SETUP_COMPUTE_PROVIDER_CATALOG.map((descriptor) => {
    const fields: SetupComputeFieldStatus[] = descriptor.fields.map(
      (field) => ({
        ...field,
        runtimeSatisfied: isConfiguredEnvValue(runtimeEnv[field.envVarName]),
        savedSatisfied: persistedEnvVarNameSet.has(field.envVarName),
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
      }),
    );

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
    input.selectedProvider ?? persistedComputeConfig.defaultProvider ?? null;
  const preselectedProvider =
    selectedProvider ??
    runtimeDefaultProvider ??
    getDefaultAvailableComputeProvider(
      excludedProviders,
      providers.map((provider) => ({
        provider: provider.provider,
        configSatisfied: provider.configSatisfied,
      })),
    );

  const selectedProviderStatus = selectedProvider
    ? providers.find((candidate) => candidate.provider === selectedProvider)
    : null;
  const setupSatisfied =
    selectedProvider !== null &&
    (selectedProviderStatus?.configSatisfied ?? false);

  return {
    selectedProvider,
    preselectedProvider,
    runtimeDefaultProvider,
    persistedDefaultProvider: persistedComputeConfig.defaultProvider,
    providers,
    workerImage,
    setupSatisfied,
  };
}
