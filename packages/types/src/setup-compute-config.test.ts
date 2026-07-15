import { describe, expect, it } from 'vitest';

import {
  buildSetupComputeStatus,
  DEVELOPMENT_MODAL_BASE_IMAGE_REF,
  deriveModalBaseImageRefDefault,
  deriveWorkerImageFromReleaseVersion,
  getDefaultAvailableComputeProvider,
  getComputeFieldValidationError,
  isAutoProvisionedComputeArtifactField,
  isComputeCredentialField,
  isComputeInfrastructureField,
  isComputeOperatorEditableField,
  normalizeDeploymentComputeConfig,
  parseExcludedComputeProviders,
  resolveDerivedModalBaseImageRef,
  resolveEffectiveDockerWorkerImage,
  resolveEffectiveModalBaseImageRef,
} from './setup-compute-config';

describe('normalizeDeploymentComputeConfig', () => {
  it('returns null for missing or invalid providers', () => {
    expect(normalizeDeploymentComputeConfig(null)).toEqual({
      defaultProvider: null,
      excludedProviders: [],
    });
    expect(
      normalizeDeploymentComputeConfig({
        defaultProvider: 'fly' as never,
      }),
    ).toEqual({ defaultProvider: null, excludedProviders: [] });
  });

  it('keeps valid providers', () => {
    expect(
      normalizeDeploymentComputeConfig({ defaultProvider: 'modal' }),
    ).toEqual({ defaultProvider: 'modal', excludedProviders: [] });
  });

  it('keeps only valid unique excluded providers', () => {
    expect(
      normalizeDeploymentComputeConfig({
        excludedProviders: ['docker', 'docker', 'invalid' as never],
      }),
    ).toEqual({ defaultProvider: null, excludedProviders: ['docker'] });
  });
});

describe('buildSetupComputeStatus', () => {
  it('is unsatisfied without an explicit provider choice', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: { DEFAULT_COMPUTE_PROVIDER: 'docker' },
    });

    expect(status.selectedProvider).toBeNull();
    expect(status.setupSatisfied).toBe(false);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.preselectedProvider).toBe('docker');
    expect(status.runtimeDefaultProvider).toBe('docker');
  });

  it('is satisfied when any hosted provider is configured in the runtime env', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        E2B_API_KEY: 'key',
        E2B_TEMPLATE_ID: 'template',
      },
    });

    expect(status.selectedProvider).toBeNull();
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
  });

  it('is satisfied when docker is chosen because it needs no credentials', () => {
    const status = buildSetupComputeStatus({
      persistedComputeConfig: { defaultProvider: 'docker' },
    });

    expect(status.selectedProvider).toBe('docker');
    expect(status.setupSatisfied).toBe(true);
  });

  it('does not select an excluded persisted provider', () => {
    const status = buildSetupComputeStatus({
      persistedComputeConfig: {
        defaultProvider: 'docker',
        excludedProviders: ['docker'],
      },
    });

    expect(status.selectedProvider).toBeNull();
    expect(status.persistedDefaultProvider).toBeNull();
    expect(status.excludedProviders).toContain('docker');
  });

  it('requires credentials for hosted providers', () => {
    const unsatisfied = buildSetupComputeStatus({
      persistedComputeConfig: { defaultProvider: 'modal' },
    });

    expect(unsatisfied.setupSatisfied).toBe(false);

    const satisfiedByRuntime = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        MODAL_BASE_IMAGE_REF: 'registry/image:tag',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });

    expect(satisfiedByRuntime.setupSatisfied).toBe(true);

    const satisfiedBySavedValues = buildSetupComputeStatus({
      persistedEnvVarNames: [
        'MODAL_TOKEN_ID',
        'MODAL_TOKEN_SECRET',
        'MODAL_BASE_IMAGE_REF',
      ],
      persistedComputeConfig: { defaultProvider: 'modal' },
    });

    expect(satisfiedBySavedValues.setupSatisfied).toBe(true);
  });

  it('ignores optional fields when computing satisfaction', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        DAYTONA_API_KEY: 'key',
        DAYTONA_SNAPSHOT_NAME: 'snapshot',
      },
      persistedComputeConfig: { defaultProvider: 'daytona' },
    });

    expect(status.setupSatisfied).toBe(true);
  });

  it('marks deployment-infrastructure fields with the infrastructure category', () => {
    const status = buildSetupComputeStatus({});
    const infrastructureByProvider = Object.fromEntries(
      status.providers.map((provider) => [
        provider.provider,
        provider.fields
          .filter((field) => isComputeInfrastructureField(field))
          .map((field) => field.envVarName),
      ]),
    );

    expect(
      status.providers.find((provider) => provider.provider === 'docker')
        ?.label,
    ).toBe('Local Docker');
    expect(infrastructureByProvider.modal).toEqual([
      'MODAL_BASE_IMAGE_REF',
      'MODAL_REGIONS',
    ]);
    expect(infrastructureByProvider.daytona).toEqual([
      'DAYTONA_SNAPSHOT_NAME',
      'DAYTONA_API_URL',
      'DAYTONA_TARGET',
    ]);
    expect(infrastructureByProvider.e2b).toEqual([
      'E2B_TEMPLATE_ID',
      'E2B_DOMAIN',
    ]);
    expect(infrastructureByProvider.blaxel).toEqual([
      'BLAXEL_IMAGE',
      'BLAXEL_REGION',
      'BLAXEL_STANDBY_MAX_COUNT',
      'BLAXEL_STANDBY_MAX_AGE_HOURS',
    ]);
    expect(infrastructureByProvider.docker).toEqual([
      'DOCKER_STANDBY_MAX_COUNT',
      'DOCKER_STANDBY_MAX_AGE_HOURS',
    ]);

    // Advanced infrastructure fields are surfaced behind an advanced area.
    const modalBaseImage = status.providers
      .find((provider) => provider.provider === 'modal')
      ?.fields.find((field) => field.envVarName === 'MODAL_BASE_IMAGE_REF');
    expect(modalBaseImage?.advanced).toBeUndefined();
    expect(modalBaseImage?.category).toBe('infrastructure');
    expect(isComputeOperatorEditableField(modalBaseImage!)).toBe(false);

    const modalRegions = status.providers
      .find((provider) => provider.provider === 'modal')
      ?.fields.find((field) => field.envVarName === 'MODAL_REGIONS');
    expect(modalRegions?.advanced).toBe(true);
    expect(isComputeOperatorEditableField(modalRegions!)).toBe(true);
    expect(modalRegions?.secret).toBe(false);
    expect(modalRegions?.required).toBe(false);

    const e2bTemplate = status.providers
      .find((provider) => provider.provider === 'e2b')
      ?.fields.find((field) => field.envVarName === 'E2B_TEMPLATE_ID');
    expect(e2bTemplate?.advanced).toBeUndefined();
    expect(isAutoProvisionedComputeArtifactField(e2bTemplate!)).toBe(true);
    expect(isComputeOperatorEditableField(e2bTemplate!)).toBe(false);

    const daytonaSnapshot = status.providers
      .find((provider) => provider.provider === 'daytona')
      ?.fields.find((field) => field.envVarName === 'DAYTONA_SNAPSHOT_NAME');
    expect(daytonaSnapshot?.advanced).toBeUndefined();
    expect(isAutoProvisionedComputeArtifactField(daytonaSnapshot!)).toBe(true);
    expect(isComputeOperatorEditableField(daytonaSnapshot!)).toBe(false);

    const blaxelImage = status.providers
      .find((provider) => provider.provider === 'blaxel')
      ?.fields.find((field) => field.envVarName === 'BLAXEL_IMAGE');
    expect(isAutoProvisionedComputeArtifactField(blaxelImage!)).toBe(true);
    expect(isComputeOperatorEditableField(blaxelImage!)).toBe(false);

    const modalToken = status.providers
      .find((provider) => provider.provider === 'modal')
      ?.fields.find((field) => field.envVarName === 'MODAL_TOKEN_ID');
    expect(modalToken?.category).toBe('credential');
    expect(isComputeCredentialField(modalToken!)).toBe(true);
  });

  it('returns plain-text savedValue for non-secret fields only', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_REGIONS: 'us',
      },
      persistedEnvVarNames: ['MODAL_TOKEN_SECRET', 'MODAL_REGIONS'],
      persistedEnvVarValues: {
        MODAL_TOKEN_SECRET: 'should-never-surface',
        MODAL_REGIONS: 'us-west',
      },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );

    expect(
      modal?.fields.find((field) => field.envVarName === 'MODAL_REGIONS')
        ?.savedValue,
    ).toBe('us');
    expect(
      modal?.fields.find((field) => field.envVarName === 'MODAL_TOKEN_SECRET')
        ?.savedValue,
    ).toBeNull();
  });

  it('keeps all providers present even when infrastructure is missing', () => {
    const status = buildSetupComputeStatus({});

    expect(status.providers.map((provider) => provider.provider)).toEqual([
      'roomote-cloud',
      'modal',
      'e2b',
      'daytona',
      'blaxel',
      'docker',
    ]);
    expect(
      status.providers.some((provider) => provider.comment === 'Recommended'),
    ).toBe(false);
    // The shared worker image is not hosted-ready with no configuration.
    expect(status.workerImage.hostedReady).toBe(false);
  });

  it('reports the shared worker image status', () => {
    const notReady = buildSetupComputeStatus({});
    expect(notReady.workerImage).toMatchObject({
      envVarName: 'DOCKER_WORKER_IMAGE',
      runtimeSatisfied: false,
      savedSatisfied: false,
      hostedImageRef: null,
      hostedReady: false,
    });

    const runtimeReady = buildSetupComputeStatus({
      runtimeEnv: {
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
    });
    expect(runtimeReady.workerImage).toMatchObject({
      runtimeSatisfied: true,
      hostedImageRef: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      hostedReady: true,
    });
  });

  it('does not treat a local worker tag as hosted-ready', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: { DOCKER_WORKER_IMAGE: 'roomote-worker:local' },
    });

    expect(status.workerImage.runtimeSatisfied).toBe(true);
    expect(status.workerImage.hostedReady).toBe(false);
    expect(status.workerImage.hostedImageRef).toBeNull();
  });

  it('ignores a registry-qualified saved worker image for hosted readiness', () => {
    const status = buildSetupComputeStatus({
      persistedEnvVarNames: ['DOCKER_WORKER_IMAGE'],
      savedWorkerImage: 'ghcr.io/roocodeinc/roomote-worker:v9.9.9',
    });

    expect(status.workerImage).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: false,
      hostedImageRef: null,
      hostedReady: false,
    });

    // Legacy saved DOCKER_WORKER_IMAGE rows no longer satisfy hosted readiness.
    // Release derivation / process env must provide a registry-qualified image.
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );
    expect(
      modal?.fields.find((field) => field.envVarName === 'MODAL_BASE_IMAGE_REF')
        ?.defaultSatisfied,
    ).toBe(false);
    const e2b = status.providers.find(
      (provider) => provider.provider === 'e2b',
    );
    expect(
      e2b?.fields.find((field) => field.envVarName === 'E2B_TEMPLATE_ID')
        ?.setupProvisionable,
    ).toBe(false);
  });

  it('satisfies provider config from manually saved infrastructure values', () => {
    const modalStatus = buildSetupComputeStatus({
      persistedEnvVarNames: [
        'MODAL_TOKEN_ID',
        'MODAL_TOKEN_SECRET',
        'MODAL_BASE_IMAGE_REF',
      ],
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    expect(
      modalStatus.providers.find((provider) => provider.provider === 'modal')
        ?.configSatisfied,
    ).toBe(true);

    const e2bStatus = buildSetupComputeStatus({
      persistedEnvVarNames: ['E2B_API_KEY', 'E2B_TEMPLATE_ID'],
      persistedComputeConfig: { defaultProvider: 'e2b' },
    });
    expect(
      e2bStatus.providers.find((provider) => provider.provider === 'e2b')
        ?.configSatisfied,
    ).toBe(true);

    const daytonaStatus = buildSetupComputeStatus({
      persistedEnvVarNames: ['DAYTONA_API_KEY', 'DAYTONA_SNAPSHOT_NAME'],
      persistedComputeConfig: { defaultProvider: 'daytona' },
    });
    expect(
      daytonaStatus.providers.find(
        (provider) => provider.provider === 'daytona',
      )?.configSatisfied,
    ).toBe(true);
  });

  it('marks the E2B template as setup-provisionable only with a registry-qualified worker image', () => {
    const findTemplateField = (
      status: ReturnType<typeof buildSetupComputeStatus>,
    ) =>
      status.providers
        .find((provider) => provider.provider === 'e2b')
        ?.fields.find((field) => field.envVarName === 'E2B_TEMPLATE_ID');

    const provisionable = buildSetupComputeStatus({
      runtimeEnv: {
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
    });

    expect(findTemplateField(provisionable)).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: false,
      defaultSatisfied: false,
      setupProvisionable: true,
    });

    // Provisionable infrastructure keeps E2B in the picker but does not
    // complete the config on its own — the built template must be persisted.
    const e2bStatus = provisionable.providers.find(
      (provider) => provider.provider === 'e2b',
    );
    expect(e2bStatus?.infrastructureSatisfied).toBe(true);
    expect(e2bStatus?.configSatisfied).toBe(false);

    const localImage = buildSetupComputeStatus({
      runtimeEnv: { DOCKER_WORKER_IMAGE: 'roomote-worker:local' },
    });

    expect(findTemplateField(localImage)?.setupProvisionable).toBe(false);
  });

  it('marks the Daytona snapshot as setup-provisionable only with a registry-qualified worker image', () => {
    const findSnapshotField = (
      status: ReturnType<typeof buildSetupComputeStatus>,
    ) =>
      status.providers
        .find((provider) => provider.provider === 'daytona')
        ?.fields.find((field) => field.envVarName === 'DAYTONA_SNAPSHOT_NAME');

    const provisionable = buildSetupComputeStatus({
      runtimeEnv: {
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
    });

    expect(findSnapshotField(provisionable)?.setupProvisionable).toBe(true);

    const daytonaStatus = provisionable.providers.find(
      (provider) => provider.provider === 'daytona',
    );
    expect(daytonaStatus?.infrastructureSatisfied).toBe(true);
    expect(daytonaStatus?.configSatisfied).toBe(false);

    const localImage = buildSetupComputeStatus({
      runtimeEnv: { DOCKER_WORKER_IMAGE: 'roomote-worker:local' },
    });

    expect(findSnapshotField(localImage)?.setupProvisionable).toBe(false);
  });

  it('prefers the wizard selection over the persisted default for preselection', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: { DEFAULT_COMPUTE_PROVIDER: 'docker' },
      persistedComputeConfig: { defaultProvider: 'modal' },
      selectedProvider: 'e2b',
    });

    expect(status.selectedProvider).toBe('e2b');
    expect(status.preselectedProvider).toBe('e2b');
    expect(status.persistedDefaultProvider).toBe('modal');
  });

  it('skips excluded runtime defaults when preselecting a provider', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        DEFAULT_COMPUTE_PROVIDER: 'docker',
        EXCLUDED_COMPUTE_PROVIDERS: 'docker',
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        MODAL_BASE_IMAGE_REF: 'registry/image:tag',
      },
    });

    expect(status.runtimeDefaultProvider).toBeNull();
    expect(status.preselectedProvider).toBe('modal');
  });

  it('satisfies the Modal base image via the derived worker-image default', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );
    const baseImageField = modal?.fields.find(
      (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
    );

    expect(baseImageField).toMatchObject({
      runtimeSatisfied: false,
      savedSatisfied: false,
      defaultSatisfied: true,
    });
    expect(modal?.configSatisfied).toBe(true);
    expect(modal?.runtimeConfigSatisfied).toBe(false);
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
  });

  it('satisfies the Modal base image from the baked release version when no worker image is configured', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        RELEASE_VERSION: 'v1.2.3',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );
    const baseImageField = modal?.fields.find(
      (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
    );

    expect(baseImageField?.defaultSatisfied).toBe(true);
    expect(modal?.configSatisfied).toBe(true);

    // The release-derived worker image also makes the E2B template and the
    // Daytona snapshot provisionable during setup.
    const e2b = status.providers.find(
      (provider) => provider.provider === 'e2b',
    );
    expect(
      e2b?.fields.find((field) => field.envVarName === 'E2B_TEMPLATE_ID')
        ?.setupProvisionable,
    ).toBe(true);
  });

  it('does not derive worker-image defaults from self-host release versions', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        RELEASE_VERSION: 'self-host-production',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );

    expect(
      modal?.fields.find((field) => field.envVarName === 'MODAL_BASE_IMAGE_REF')
        ?.defaultSatisfied,
    ).toBe(false);
    expect(modal?.configSatisfied).toBe(false);
  });

  it('does not derive a Modal base image default from a local worker tag', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'roomote-worker:local',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );
    const baseImageField = modal?.fields.find(
      (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
    );

    expect(baseImageField?.defaultSatisfied).toBe(false);
    expect(modal?.configSatisfied).toBe(false);
    expect(status.setupSatisfied).toBe(false);
  });

  it('uses the development Modal base image when no hosted worker image is configured', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        NODE_ENV: 'development',
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'roomote-worker:local',
      },
      persistedComputeConfig: { defaultProvider: 'modal' },
    });
    const modal = status.providers.find(
      (provider) => provider.provider === 'modal',
    );
    const baseImageField = modal?.fields.find(
      (field) => field.envVarName === 'MODAL_BASE_IMAGE_REF',
    );

    expect(status.workerImage).toMatchObject({
      runtimeSatisfied: true,
      hostedImageRef: DEVELOPMENT_MODAL_BASE_IMAGE_REF,
      hostedReady: true,
    });
    expect(baseImageField?.defaultSatisfied).toBe(true);
    expect(modal?.configSatisfied).toBe(true);
    expect(status.setupSatisfied).toBe(true);
  });

  it('reports the immutable development worker image used for provisioning', () => {
    const status = buildSetupComputeStatus({
      runtimeEnv: {
        NODE_ENV: 'development',
        ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF:
          'ghcr.io/roocodeinc/roomote-worker:develop-62a69ba7',
      },
    });

    expect(status.workerImage).toMatchObject({
      hostedImageRef: 'ghcr.io/roocodeinc/roomote-worker:develop-62a69ba7',
      hostedReady: true,
    });
  });

  it('reports provider infrastructure availability for the picker', () => {
    const withWorkerImage = buildSetupComputeStatus({
      runtimeEnv: {
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
    });

    expect(
      Object.fromEntries(
        withWorkerImage.providers.map((provider) => [
          provider.provider,
          provider.infrastructureSatisfied,
        ]),
      ),
    ).toEqual({
      'roomote-cloud': true,
      modal: true,
      // Daytona and E2B stay offered because their worker base images are
      // provisionable during setup from the registry-qualified worker image.
      daytona: true,
      e2b: true,
      // Blaxel can build its sandbox image from the registry-qualified worker
      // image during setup, just like E2B and Daytona provision artifacts.
      blaxel: true,
      docker: true,
    });

    const withBlaxelImage = buildSetupComputeStatus({
      runtimeEnv: {
        BLAXEL_IMAGE: 'sandbox/roomote-worker:version',
      },
    });
    expect(
      withBlaxelImage.providers.find(
        (provider) => provider.provider === 'blaxel',
      )?.infrastructureSatisfied,
    ).toBe(true);

    const withoutInfrastructure = buildSetupComputeStatus({});

    expect(
      Object.fromEntries(
        withoutInfrastructure.providers.map((provider) => [
          provider.provider,
          provider.infrastructureSatisfied,
        ]),
      ),
    ).toEqual({
      'roomote-cloud': true,
      modal: false,
      daytona: false,
      e2b: false,
      blaxel: false,
      docker: true,
    });

    const withRuntimeInfrastructure = buildSetupComputeStatus({
      runtimeEnv: {
        DAYTONA_SNAPSHOT_NAME: 'roomote-worker',
        MODAL_BASE_IMAGE_REF: 'registry/image:tag',
        E2B_TEMPLATE_ID: 'roomote-worker',
      },
    });

    expect(
      Object.fromEntries(
        withRuntimeInfrastructure.providers.map((provider) => [
          provider.provider,
          provider.infrastructureSatisfied,
        ]),
      ),
    ).toEqual({
      'roomote-cloud': true,
      modal: true,
      daytona: true,
      e2b: true,
      blaxel: false,
      docker: true,
    });
  });
});

describe('getComputeFieldValidationError', () => {
  const field = {
    envVarName: 'BLAXEL_STANDBY_MAX_AGE_HOURS',
    label: 'Retention period (hours)',
    required: false,
    category: 'infrastructure' as const,
    input: { type: 'number' as const, min: 1, max: 168, step: 1 },
  };

  it('accepts blank and in-range whole-number values', () => {
    expect(getComputeFieldValidationError(field, '')).toBeNull();
    expect(getComputeFieldValidationError(field, '72')).toBeNull();
  });

  it('rejects values outside the configured constraints', () => {
    expect(getComputeFieldValidationError(field, '0')).toBe(
      'Retention period (hours) must be at least 1.',
    );
    expect(getComputeFieldValidationError(field, '169')).toBe(
      'Retention period (hours) must be at most 168.',
    );
    expect(getComputeFieldValidationError(field, '1.5')).toBe(
      'Retention period (hours) must be a whole number.',
    );
  });
});

describe('deriveWorkerImageFromReleaseVersion', () => {
  it('derives the published worker image from the baked release version', () => {
    expect(
      deriveWorkerImageFromReleaseVersion({ RELEASE_VERSION: 'v1.2.3' }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:v1.2.3');
    expect(
      deriveWorkerImageFromReleaseVersion({
        RELEASE_VERSION: 'develop-abc12345',
      }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:develop-abc12345');
  });

  it('honors a ROOMOTE_WORKER_IMAGE_REPO override', () => {
    expect(
      deriveWorkerImageFromReleaseVersion({
        RELEASE_VERSION: 'v1.2.3',
        ROOMOTE_WORKER_IMAGE_REPO: 'registry.example.com/fork/worker',
      }),
    ).toBe('registry.example.com/fork/worker:v1.2.3');
    expect(
      deriveWorkerImageFromReleaseVersion({
        RELEASE_VERSION: 'v1.2.3',
        ROOMOTE_WORKER_IMAGE_REPO: '   ',
      }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:v1.2.3');
  });

  it('returns null for unset or self-host release versions', () => {
    expect(deriveWorkerImageFromReleaseVersion({})).toBeNull();
    expect(
      deriveWorkerImageFromReleaseVersion({ RELEASE_VERSION: '' }),
    ).toBeNull();
    expect(
      deriveWorkerImageFromReleaseVersion({ RELEASE_VERSION: '   ' }),
    ).toBeNull();
    expect(
      deriveWorkerImageFromReleaseVersion({ RELEASE_VERSION: 'self-host' }),
    ).toBeNull();
    expect(
      deriveWorkerImageFromReleaseVersion({
        RELEASE_VERSION: 'self-host-local',
      }),
    ).toBeNull();
    expect(
      deriveWorkerImageFromReleaseVersion({
        RELEASE_VERSION: 'self-host-production',
      }),
    ).toBeNull();
  });
});

describe('resolveEffectiveDockerWorkerImage', () => {
  it('prefers an explicit DOCKER_WORKER_IMAGE over the derived default', () => {
    expect(
      resolveEffectiveDockerWorkerImage({
        DOCKER_WORKER_IMAGE: 'registry.example.com/custom/worker:pinned',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('registry.example.com/custom/worker:pinned');
  });

  it('falls back to the release-version derivation when unset or blank', () => {
    expect(
      resolveEffectiveDockerWorkerImage({ RELEASE_VERSION: 'v1.2.3' }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:v1.2.3');
    expect(
      resolveEffectiveDockerWorkerImage({
        DOCKER_WORKER_IMAGE: '   ',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:v1.2.3');
    expect(resolveEffectiveDockerWorkerImage({})).toBeNull();
  });
});

describe('deriveModalBaseImageRefDefault', () => {
  it('returns registry-qualified worker images', () => {
    expect(
      deriveModalBaseImageRefDefault(
        'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      ),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:v1.2.3');
    expect(
      deriveModalBaseImageRefDefault(
        '  ghcr.io/roocodeinc/roomote-worker:develop-abc123  ',
      ),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:develop-abc123');
  });

  it('rejects blank and non-registry-qualified images', () => {
    expect(deriveModalBaseImageRefDefault(undefined)).toBeNull();
    expect(deriveModalBaseImageRefDefault(null)).toBeNull();
    expect(deriveModalBaseImageRefDefault('')).toBeNull();
    expect(deriveModalBaseImageRefDefault('   ')).toBeNull();
    expect(deriveModalBaseImageRefDefault('roomote-worker:local')).toBeNull();
  });
});

describe('resolveDerivedModalBaseImageRef', () => {
  it('derives the Modal base image from the effective worker image inputs', () => {
    expect(resolveDerivedModalBaseImageRef({ RELEASE_VERSION: 'v1.2.3' })).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
    expect(
      resolveDerivedModalBaseImageRef({
        DOCKER_WORKER_IMAGE: 'registry.example.com/custom/worker:tag',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('registry.example.com/custom/worker:tag');
  });

  it('falls back to the development Modal image when no hosted image is configured', () => {
    expect(resolveDerivedModalBaseImageRef({ NODE_ENV: 'development' })).toBe(
      'ghcr.io/roocodeinc/roomote-worker:develop',
    );
    expect(
      resolveDerivedModalBaseImageRef({
        APP_ENV: 'development',
        DOCKER_WORKER_IMAGE: 'roomote-worker:local',
      }),
    ).toBe(DEVELOPMENT_MODAL_BASE_IMAGE_REF);
  });

  it('uses the immutable development worker image selected by the dev launcher', () => {
    expect(
      resolveDerivedModalBaseImageRef({
        NODE_ENV: 'development',
        ROOMOTE_DEVELOPMENT_WORKER_IMAGE_REF:
          'ghcr.io/roocodeinc/roomote-worker:develop-62a69ba7',
      }),
    ).toBe('ghcr.io/roocodeinc/roomote-worker:develop-62a69ba7');
  });
});

describe('resolveEffectiveModalBaseImageRef', () => {
  it('prefers an explicit Modal base image ref over the derived default', () => {
    expect(
      resolveEffectiveModalBaseImageRef({
        MODAL_BASE_IMAGE_REF: 'registry.example.com/modal:explicit',
        RELEASE_VERSION: 'v1.2.3',
      }),
    ).toBe('registry.example.com/modal:explicit');
  });
});

describe('parseExcludedComputeProviders', () => {
  it('parses valid provider ids and ignores invalid entries', () => {
    expect(
      Array.from(
        parseExcludedComputeProviders(' docker, modal ,invalid,,docker '),
      ),
    ).toEqual(['docker', 'modal']);
  });
});

describe('getDefaultAvailableComputeProvider', () => {
  it('returns the first non-excluded provider', () => {
    expect(
      getDefaultAvailableComputeProvider(new Set(['docker', 'modal']), [
        { provider: 'daytona', configSatisfied: true },
      ]),
    ).toBe('daytona');
  });

  it('keeps docker when it is not excluded', () => {
    expect(getDefaultAvailableComputeProvider(new Set(['modal']))).toBe(
      'docker',
    );
  });

  it('falls back to docker when excluded providers are not configured', () => {
    expect(
      getDefaultAvailableComputeProvider(new Set(['docker']), [
        { provider: 'modal', configSatisfied: false },
        { provider: 'daytona', configSatisfied: false },
        { provider: 'e2b', configSatisfied: false },
      ]),
    ).toBe('docker');
  });

  it('ignores optional-only provider env when choosing a fallback', () => {
    expect(
      getDefaultAvailableComputeProvider(new Set(['docker']), [
        { provider: 'modal', configSatisfied: false },
        { provider: 'daytona', configSatisfied: false },
        { provider: 'e2b', configSatisfied: false },
      ]),
    ).toBe('docker');
  });

  it('falls back to docker when every provider is excluded', () => {
    expect(
      getDefaultAvailableComputeProvider(
        new Set([
          'roomote-cloud',
          'docker',
          'modal',
          'daytona',
          'e2b',
          'blaxel',
        ]),
      ),
    ).toBe('docker');
  });
});
