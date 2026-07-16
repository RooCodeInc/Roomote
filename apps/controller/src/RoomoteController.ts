import {
  resolveRoomoteCloudBackend,
  resolveRoomoteCloudModalAppName,
  type ComputeProvider,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  type TaskRun,
  resolveComputeProviderEnvValues,
} from '@roomote/db/server';

import { BaseController } from './BaseController';
import {
  cleanupStaleDockerSandboxes,
  spawnDaytonaWorker,
  spawnDockerWorker,
  spawnE2bWorker,
  spawnBlaxelWorker,
  spawnModalWorker,
} from './compute-providers';

export class RoomoteController extends BaseController {
  private dockerCleanupInterval?: NodeJS.Timeout;

  public constructor(
    protected readonly appEnv: 'development' | 'preview' | 'production',
  ) {
    super(appEnv);

    const hasAnyModalEcrConfig = !!(
      Env.MODAL_ECR_OIDC_ROLE_ARN || Env.MODAL_ECR_REGION
    );

    const hasFullModalEcrConfig = !!(
      Env.MODAL_ECR_OIDC_ROLE_ARN && Env.MODAL_ECR_REGION
    );

    const hasAnyModalRegistryAuthConfig = !!(
      Env.MODAL_REGISTRY_USERNAME || Env.MODAL_REGISTRY_PASSWORD
    );

    const hasFullModalRegistryAuthConfig = !!(
      Env.MODAL_REGISTRY_USERNAME && Env.MODAL_REGISTRY_PASSWORD
    );

    if (hasAnyModalEcrConfig && !hasFullModalEcrConfig) {
      throw new Error(
        'Modal ECR config is partial; set MODAL_ECR_OIDC_ROLE_ARN and MODAL_ECR_REGION together',
      );
    }

    if (hasAnyModalRegistryAuthConfig && !hasFullModalRegistryAuthConfig) {
      throw new Error(
        'Modal registry auth config is partial; set MODAL_REGISTRY_USERNAME and MODAL_REGISTRY_PASSWORD together',
      );
    }

    if (hasFullModalEcrConfig && hasFullModalRegistryAuthConfig) {
      throw new Error(
        'Modal registry auth and ECR OIDC auth cannot be configured together',
      );
    }
  }

  protected async spawnFreshWorker(
    taskRun: TaskRun,
    authToken: string,
    deploymentSlug: string,
    timeoutMs: number,
    provider: ComputeProvider,
  ) {
    // Credentials resolve from the runtime env first and fall back to the
    // encrypted deployment env vars saved by the setup flow.
    const resolvedEnv = await resolveComputeProviderEnvValues(provider, {
      // The validated env includes typed numeric policy values; the resolver
      // normalizes scalars before combining them with saved string values.
      runtimeEnv: Env,
    });

    switch (provider) {
      // Roomote spawns with deployment-managed credentials, persisting its
      // own vendor on the task run. ROOMOTE_CLOUD_BACKEND selects the engine
      // backing it; only the Modal backend exists today, so both providers
      // share the Modal spawn path below — a new backend dispatches to its
      // own spawn function here after the backend resolution.
      case 'modal':
      case 'roomote': {
        if (provider === 'roomote') {
          // Throws on an unsupported backend; the resolved value is 'modal'
          // until more ROOMOTE_CLOUD_BACKENDS exist.
          resolveRoomoteCloudBackend(resolvedEnv);
        }

        const modalTokenId =
          provider === 'roomote'
            ? resolvedEnv.ROOMOTE_CLOUD_TOKEN_ID
            : resolvedEnv.MODAL_TOKEN_ID;
        const modalTokenSecret =
          provider === 'roomote'
            ? resolvedEnv.ROOMOTE_CLOUD_TOKEN_SECRET
            : resolvedEnv.MODAL_TOKEN_SECRET;
        const modalBaseImageRef = resolvedEnv.MODAL_BASE_IMAGE_REF;

        if (!modalTokenId || !modalTokenSecret) {
          throw new Error(
            provider === 'roomote'
              ? 'ROOMOTE_CLOUD_TOKEN_ID and ROOMOTE_CLOUD_TOKEN_SECRET are required to spawn Roomote Cloud workers'
              : 'MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required to spawn Modal workers',
          );
        }

        if (!modalBaseImageRef) {
          throw new Error(
            'MODAL_BASE_IMAGE_REF is required to spawn Modal workers',
          );
        }

        await spawnModalWorker(taskRun, authToken, {
          vendor: provider,
          deploymentSlug: deploymentSlug,
          modalTags: this.buildSandboxTags(),
          modalTokenId,
          modalTokenSecret,
          modalEndpoint: Env.MODAL_ENDPOINT,
          modalEnvironment: Env.MODAL_ENVIRONMENT,
          modalAppName:
            provider === 'roomote'
              ? resolveRoomoteCloudModalAppName({
                  ROOMOTE_CLOUD_APP_NAME: resolvedEnv.ROOMOTE_CLOUD_APP_NAME,
                  ROOMOTE_CLOUD_SLUG: resolvedEnv.ROOMOTE_CLOUD_SLUG,
                })
              : Env.MODAL_APP_NAME,
          modalBaseImageRef,
          modalRegistryUsername: Env.MODAL_REGISTRY_USERNAME,
          modalRegistryPassword: Env.MODAL_REGISTRY_PASSWORD,
          modalEcrOidcRoleArn: Env.MODAL_ECR_OIDC_ROLE_ARN,
          modalEcrRegion: Env.MODAL_ECR_REGION,
          modalRegions: resolvedEnv.MODAL_REGIONS,
          modalVmMemoryMiB: Env.MODAL_VM_MEMORY_MIB,
          modalTimeoutMs: timeoutMs,
          localTarballPath: this.localWorkerReleasePath,
        });
        return;
      }
      case 'docker': {
        await spawnDockerWorker(taskRun, authToken, {
          image: Env.DOCKER_WORKER_IMAGE,
          platform: Env.DOCKER_WORKER_PLATFORM,
          network: Env.DOCKER_WORKER_NETWORK,
          dockerTimeoutMs: timeoutMs,
          cpuLimit: Env.DOCKER_WORKER_CPU_LIMIT,
          memoryLimit: Env.DOCKER_WORKER_MEMORY_LIMIT,
          taskDaemonMemoryLimit: Env.DOCKER_TASK_DAEMON_MEMORY_LIMIT,
          pidsLimit: Env.DOCKER_WORKER_PIDS_LIMIT,
          diskLimit: Env.DOCKER_WORKER_DISK_LIMIT,
          allowUnboundedDisk: Env.DOCKER_WORKER_ALLOW_UNBOUNDED_DISK,
          logMaxSize: Env.DOCKER_WORKER_LOG_MAX_SIZE,
          logMaxFiles: Env.DOCKER_WORKER_LOG_MAX_FILES,
          egressPolicy: Env.DOCKER_WORKER_EGRESS_POLICY,
          localWorkerReleasePath: this.localWorkerReleasePath,
          deploymentSlug: deploymentSlug,
        });
        return;
      }
      case 'daytona': {
        const daytonaApiKey = resolvedEnv.DAYTONA_API_KEY;
        const daytonaSnapshotName = resolvedEnv.DAYTONA_SNAPSHOT_NAME;

        if (!daytonaApiKey) {
          throw new Error(
            'DAYTONA_API_KEY is required to spawn Daytona workers',
          );
        }

        if (!daytonaSnapshotName) {
          throw new Error(
            'DAYTONA_SNAPSHOT_NAME is required to spawn Daytona workers',
          );
        }

        await spawnDaytonaWorker(taskRun, authToken, {
          deploymentSlug: deploymentSlug,
          daytonaTags: this.buildSandboxTags(),
          daytonaApiKey,
          daytonaApiUrl: resolvedEnv.DAYTONA_API_URL,
          daytonaTarget: resolvedEnv.DAYTONA_TARGET,
          daytonaSnapshotName,
          daytonaTimeoutMs: timeoutMs,
          localTarballPath: this.localWorkerReleasePath,
        });
        return;
      }
      case 'e2b': {
        const e2bApiKey = resolvedEnv.E2B_API_KEY;
        const e2bTemplateId = resolvedEnv.E2B_TEMPLATE_ID;

        if (!e2bApiKey) {
          throw new Error('E2B_API_KEY is required to spawn E2B workers');
        }

        if (!e2bTemplateId) {
          throw new Error('E2B_TEMPLATE_ID is required to spawn E2B workers');
        }

        await spawnE2bWorker(taskRun, authToken, {
          deploymentSlug: deploymentSlug,
          e2bTags: this.buildSandboxTags(),
          e2bApiKey,
          e2bDomain: resolvedEnv.E2B_DOMAIN,
          e2bTemplateId,
          // E2B rejects sandbox timeouts above the plan's lifetime cap, so
          // clamp to the configured ceiling; sleep-check's provider-timeout
          // backstop reads the real deadline and winds the task run down first.
          e2bTimeoutMs: Math.min(timeoutMs, Env.E2B_MAX_SANDBOX_TIMEOUT_MS),
          localTarballPath: this.localWorkerReleasePath,
        });
        return;
      }
      case 'blaxel': {
        const blaxelApiKey = resolvedEnv.BL_API_KEY;
        const blaxelWorkspace = resolvedEnv.BL_WORKSPACE;
        const blaxelImage = resolvedEnv.BLAXEL_IMAGE;
        if (!blaxelApiKey || !blaxelWorkspace || !blaxelImage) {
          throw new Error(
            'BL_API_KEY, BL_WORKSPACE, and BLAXEL_IMAGE are required to spawn Blaxel workers',
          );
        }
        await spawnBlaxelWorker(taskRun, authToken, {
          deploymentSlug,
          blaxelTags: this.buildSandboxTags(),
          blaxelApiKey,
          blaxelWorkspace,
          blaxelImage,
          blaxelRegion: resolvedEnv.BLAXEL_REGION,
          blaxelTimeoutMs: timeoutMs,
          localTarballPath: this.localWorkerReleasePath,
        });
        return;
      }
      default: {
        const _exhaustive: never = provider;
        throw new Error(`Unsupported compute provider: ${_exhaustive}`);
      }
    }
  }

  private buildSandboxTags(): Record<string, string> {
    return {
      app_environment: this.appEnv,
    };
  }

  // Reaping is best-effort: a transient Docker daemon or control-network
  // error (for example a rolling deploy replacing the API container) must not
  // crash the controller, especially not during startup.
  private async cleanStaleDockerSandboxes(): Promise<void> {
    try {
      await cleanupStaleDockerSandboxes({
        controlNetwork: Env.DOCKER_WORKER_NETWORK,
      });
    } catch (error) {
      console.error(
        `[RoomoteController] Failed to clean stale Docker sandboxes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected override async setup(): Promise<void> {
    await this.cleanStaleDockerSandboxes();
    this.dockerCleanupInterval = setInterval(() => {
      void this.cleanStaleDockerSandboxes();
    }, 60_000);
    this.dockerCleanupInterval.unref();
  }

  protected override async teardown(): Promise<void> {
    if (this.dockerCleanupInterval) {
      clearInterval(this.dockerCleanupInterval);
      this.dockerCleanupInterval = undefined;
    }
  }
}
