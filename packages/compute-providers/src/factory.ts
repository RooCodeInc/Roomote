import {
  resolveConfiguredComputeProviderResources,
  resolveEffectiveModalBaseImageRef,
  resolveRoomoteCloudBackend,
  resolveRoomoteCloudModalAppName,
  SANDBOX_DEFAULT_MEMORY_MIB,
  SANDBOX_DEFAULT_VCPUS,
} from '@roomote/types';

import type {
  ComputeProviderClient,
  ComputeProviderFactoryOptions,
  BlaxelConfig,
  DaytonaConfig,
  E2bConfig,
  ModalConfig,
} from './types';
import { assertDefined } from './errors';
import {
  ModalClient,
  RoomoteBrokerClient,
  DockerClient,
  DaytonaClient,
  E2bClient,
  BlaxelClient,
} from './adapters';

const MODAL_DEFAULT_MEMORY_LIMIT_MIB = SANDBOX_DEFAULT_MEMORY_MIB * 2;

export { getComputeProviderCapabilities } from '@roomote/types';

/**
 * Parse a comma-separated Modal regions env/config string into a clean list.
 * Empty tokens after trim are dropped. Returns undefined when nothing remains.
 */
export function parseModalRegions(
  value: string | string[] | undefined | null,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  const tokens = (Array.isArray(value) ? value : value.split(','))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.length > 0 ? tokens : undefined;
}

export function createComputeProviderClient(
  options: ComputeProviderFactoryOptions,
): ComputeProviderClient {
  const envValue = (name: string): string | undefined =>
    options.envFallback?.[name] ?? process.env[name];

  switch (options.provider) {
    // Roomote is the deployment-managed provider: credentials come from
    // ROOMOTE_CLOUD_TOKEN_ID/SECRET, and ROOMOTE_CLOUD_BACKEND selects the
    // engine that runs its sandboxes. Only the Modal backend exists today,
    // so both providers share the Modal client construction below; a new
    // backend adds its branch here after the backend resolution.
    case 'modal':
    case 'roomote': {
      if (options.provider === 'roomote') {
        // Throws on an unsupported backend.
        const backend = resolveRoomoteCloudBackend({
          ROOMOTE_CLOUD_BACKEND: envValue('ROOMOTE_CLOUD_BACKEND'),
        });

        // Broker backend: the deployment holds no Modal credentials. The
        // token env vars carry the tenant id + derived broker credential,
        // and registry/ECR pull secrets are broker-side by design — never
        // read them here.
        if (backend === 'broker') {
          const brokerUrl = envValue('ROOMOTE_CLOUD_BROKER_URL');
          const tenantId = envValue('ROOMOTE_CLOUD_TOKEN_ID');
          const brokerKey = envValue('ROOMOTE_CLOUD_TOKEN_SECRET');
          const brokerBaseImageRef =
            options.config?.baseImageRef ??
            resolveEffectiveModalBaseImageRef({
              MODAL_BASE_IMAGE_REF: envValue('MODAL_BASE_IMAGE_REF'),
              DOCKER_WORKER_IMAGE: envValue('DOCKER_WORKER_IMAGE'),
              RELEASE_VERSION: envValue('RELEASE_VERSION'),
              ROOMOTE_WORKER_IMAGE_REPO: envValue('ROOMOTE_WORKER_IMAGE_REPO'),
              APP_ENV: envValue('APP_ENV'),
              NODE_ENV: envValue('NODE_ENV'),
            }) ??
            undefined;

          assertDefined(brokerUrl, 'Missing ROOMOTE_CLOUD_BROKER_URL');
          assertDefined(tenantId, 'Missing ROOMOTE_CLOUD_TOKEN_ID');
          assertDefined(brokerKey, 'Missing ROOMOTE_CLOUD_TOKEN_SECRET');
          assertDefined(brokerBaseImageRef, 'Missing MODAL_BASE_IMAGE_REF');

          const brokerResources = resolveConfiguredComputeProviderResources({
            provider: options.provider,
            configuredCpuCores: options.config?.cpu,
            configuredMemoryMiB: options.config?.memoryMiB,
          });
          const brokerRegions =
            parseModalRegions(options.config?.regions) ??
            parseModalRegions(envValue('MODAL_REGIONS'));

          return new RoomoteBrokerClient({
            brokerUrl,
            tenantId,
            brokerKey,
            baseImageRef: brokerBaseImageRef,
            ...(brokerRegions ? { regions: brokerRegions } : {}),
            ...(options.config?.timeoutMs
              ? { timeoutMs: options.config.timeoutMs }
              : {}),
            ...(brokerResources.configuredCpuCores !== null
              ? { cpu: brokerResources.configuredCpuCores }
              : {}),
            cpuLimit: options.config?.cpuLimit ?? SANDBOX_DEFAULT_VCPUS,
            ...(brokerResources.configuredMemoryMiB !== null
              ? { memoryMiB: brokerResources.configuredMemoryMiB }
              : {}),
            memoryLimitMiB:
              options.config?.memoryLimitMiB ?? MODAL_DEFAULT_MEMORY_LIMIT_MIB,
            ...(options.config?.vmRuntime ? { vmRuntime: true } : {}),
          });
        }
      }

      const tokenIdEnvVar =
        options.provider === 'roomote'
          ? 'ROOMOTE_CLOUD_TOKEN_ID'
          : 'MODAL_TOKEN_ID';
      const tokenSecretEnvVar =
        options.provider === 'roomote'
          ? 'ROOMOTE_CLOUD_TOKEN_SECRET'
          : 'MODAL_TOKEN_SECRET';

      const tokenId = options.config?.tokenId ?? envValue(tokenIdEnvVar);

      const tokenSecret =
        options.config?.tokenSecret ?? envValue(tokenSecretEnvVar);

      // The published worker image doubles as the Modal base image, so a
      // missing ref falls back to the deployment's effective worker image
      // (explicit DOCKER_WORKER_IMAGE, or derived from the baked
      // RELEASE_VERSION on published app images), then the development-only
      // public latest image.
      const baseImageRef =
        options.config?.baseImageRef ??
        resolveEffectiveModalBaseImageRef({
          MODAL_BASE_IMAGE_REF: envValue('MODAL_BASE_IMAGE_REF'),
          DOCKER_WORKER_IMAGE: envValue('DOCKER_WORKER_IMAGE'),
          RELEASE_VERSION: envValue('RELEASE_VERSION'),
          ROOMOTE_WORKER_IMAGE_REPO: envValue('ROOMOTE_WORKER_IMAGE_REPO'),
          APP_ENV: envValue('APP_ENV'),
          NODE_ENV: envValue('NODE_ENV'),
        }) ??
        undefined;

      const registryUsername =
        options.config?.registryUsername ?? envValue('MODAL_REGISTRY_USERNAME');

      const registryPassword =
        options.config?.registryPassword ?? envValue('MODAL_REGISTRY_PASSWORD');

      const modalEndpoint = envValue('MODAL_ENDPOINT');
      const modalEnvironment = envValue('MODAL_ENVIRONMENT');
      // The managed provider derives its app name from the engine-neutral
      // deployment slug with its own dedicated override; plain Modal keeps
      // reading only its own env var, and neither consults the other's.
      const modalAppName =
        options.provider === 'roomote'
          ? resolveRoomoteCloudModalAppName({
              ROOMOTE_CLOUD_APP_NAME: envValue('ROOMOTE_CLOUD_APP_NAME'),
              ROOMOTE_CLOUD_SLUG: envValue('ROOMOTE_CLOUD_SLUG'),
            })
          : envValue('MODAL_APP_NAME');
      const modalEcrOidcRoleArn = envValue('MODAL_ECR_OIDC_ROLE_ARN');
      const modalEcrRegion = envValue('MODAL_ECR_REGION');
      const modalRegions = parseModalRegions(envValue('MODAL_REGIONS'));
      const configRegions = parseModalRegions(options.config?.regions);

      assertDefined(tokenId, `Missing ${tokenIdEnvVar}`);
      assertDefined(tokenSecret, `Missing ${tokenSecretEnvVar}`);
      assertDefined(baseImageRef, 'Missing MODAL_BASE_IMAGE_REF');

      const configuredResources = resolveConfiguredComputeProviderResources({
        provider: options.provider,
        configuredCpuCores: options.config?.cpu,
        configuredMemoryMiB: options.config?.memoryMiB,
      });

      const config: ModalConfig = {
        ...(options.config ?? {}),
        vendor: options.config?.vendor ?? options.provider,
        tokenId,
        tokenSecret,
        baseImageRef,
        ...(options.config?.endpoint === undefined && modalEndpoint
          ? { endpoint: modalEndpoint }
          : {}),
        ...(options.config?.environment === undefined && modalEnvironment
          ? { environment: modalEnvironment }
          : {}),
        ...(options.config?.appName === undefined && modalAppName
          ? { appName: modalAppName }
          : {}),
        ...(registryUsername ? { registryUsername } : {}),
        ...(registryPassword ? { registryPassword } : {}),
        ...(options.config?.ecrOidcRoleArn === undefined && modalEcrOidcRoleArn
          ? { ecrOidcRoleArn: modalEcrOidcRoleArn }
          : {}),
        ...(options.config?.ecrRegion === undefined && modalEcrRegion
          ? { ecrRegion: modalEcrRegion }
          : {}),
        ...(options.config?.regions === undefined && modalRegions
          ? { regions: modalRegions }
          : configRegions
            ? { regions: configRegions }
            : options.config?.regions !== undefined
              ? { regions: undefined }
              : {}),
        ...(configuredResources.configuredCpuCores !== null
          ? { cpu: configuredResources.configuredCpuCores }
          : {}),
        ...(options.config?.cpuLimit !== undefined
          ? { cpuLimit: options.config.cpuLimit }
          : { cpuLimit: SANDBOX_DEFAULT_VCPUS }),
        ...(configuredResources.configuredMemoryMiB !== null
          ? { memoryMiB: configuredResources.configuredMemoryMiB }
          : {}),
        ...(options.config?.memoryLimitMiB !== undefined
          ? { memoryLimitMiB: options.config.memoryLimitMiB }
          : { memoryLimitMiB: MODAL_DEFAULT_MEMORY_LIMIT_MIB }),
      };

      return new ModalClient(config);
    }

    case 'docker':
      return new DockerClient();

    case 'daytona': {
      const apiKey = options.config?.apiKey ?? envValue('DAYTONA_API_KEY');

      const snapshotName =
        options.config?.snapshotName ?? envValue('DAYTONA_SNAPSHOT_NAME');

      const daytonaApiUrl = envValue('DAYTONA_API_URL');
      const daytonaTarget = envValue('DAYTONA_TARGET');

      assertDefined(apiKey, 'Missing DAYTONA_API_KEY');
      assertDefined(snapshotName, 'Missing DAYTONA_SNAPSHOT_NAME');

      const config: DaytonaConfig = {
        ...(options.config ?? {}),
        apiKey,
        snapshotName,
        ...(options.config?.apiUrl === undefined && daytonaApiUrl
          ? { apiUrl: daytonaApiUrl }
          : {}),
        ...(options.config?.target === undefined && daytonaTarget
          ? { target: daytonaTarget }
          : {}),
      };

      return new DaytonaClient(config);
    }

    case 'e2b': {
      const apiKey = options.config?.apiKey ?? envValue('E2B_API_KEY');

      const templateId =
        options.config?.templateId ?? envValue('E2B_TEMPLATE_ID');

      const e2bDomain = envValue('E2B_DOMAIN');

      assertDefined(apiKey, 'Missing E2B_API_KEY');
      assertDefined(templateId, 'Missing E2B_TEMPLATE_ID');

      const config: E2bConfig = {
        ...(options.config ?? {}),
        apiKey,
        templateId,
        ...(options.config?.domain === undefined && e2bDomain
          ? { domain: e2bDomain }
          : {}),
      };

      return new E2bClient(config);
    }

    case 'blaxel': {
      const apiKey = options.config?.apiKey ?? envValue('BL_API_KEY');
      const workspace = options.config?.workspace ?? envValue('BL_WORKSPACE');
      const image = options.config?.image ?? envValue('BLAXEL_IMAGE');
      const region = envValue('BLAXEL_REGION');
      const standbyMaxAgeHours = Number(
        envValue('BLAXEL_STANDBY_MAX_AGE_HOURS'),
      );

      assertDefined(apiKey, 'Missing BL_API_KEY');
      assertDefined(workspace, 'Missing BL_WORKSPACE');
      assertDefined(image, 'Missing BLAXEL_IMAGE');

      const config: BlaxelConfig = {
        ...(options.config ?? {}),
        apiKey,
        workspace,
        image,
        ...(options.config?.region === undefined && region ? { region } : {}),
        ...(options.config?.standbyTtlMs === undefined &&
        Number.isFinite(standbyMaxAgeHours) &&
        standbyMaxAgeHours > 0
          ? { standbyTtlMs: standbyMaxAgeHours * 60 * 60 * 1_000 }
          : {}),
      };
      return new BlaxelClient(config);
    }

    default: {
      const _exhaustive: never = options;
      throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}
