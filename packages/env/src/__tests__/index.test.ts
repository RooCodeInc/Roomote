import {
  Env,
  areCuratedIntegrationsEnabled,
  assertSecureBootBinding,
  createRoomoteEnv,
  getActiveInsecureLocalSecrets,
  getAllowedDevOrigins,
  getDefaultDocsUrl,
  getDefaultPreviewProxyBaseUrl,
  getDefaultRoomoteAppUrl,
  getDefaultTrpcUrl,
  getWebBundledEnvFilePaths,
  isAutoGenerateKeysEnabled,
  isExposedBindHost,
  isRoomoteCloudEnabled,
  rehydrateEnv,
  resolveAppEnv,
  shouldAutoGenerateAuthKeypairs,
} from '../index';

const LOCAL_ENCRYPTION_KEY = 'local-roomote-encryption-key-0001';
const LOCAL_DASHBOARD_PASSWORD = 'roomote-local-admin';
const LOCAL_ARTIFACT_SIGNING_KEY = 'local-roomote-artifact-signing-key-1';

const productionCoreEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  R_APP_ENV: 'production',
  R_APP_URL: 'https://roomote.example.com',
  TRPC_URL: 'https://api.roomote.example.com',
  DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
  REDIS_URL: 'redis://redis:6379',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_PRESIGN_ENDPOINT: 'https://s3-presign.example.com',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'roomote',
  S3_SECRET_ACCESS_KEY: 'roomote-artifacts-secret',
  S3_BUCKET_ARTIFACTS: 'roomote-artifacts',
  JOB_AUTH_PRIVATE_KEY: 'job-private-key',
  JOB_AUTH_PUBLIC_KEY: 'job-public-key',
  PREVIEW_AUTH_PRIVATE_KEY: 'preview-private-key',
  PREVIEW_AUTH_PUBLIC_KEY: 'preview-public-key',
  DASHBOARD_PASSWORD: 'roomote-admin-password',
  ENCRYPTION_KEY: '12345678901234567890123456789012',
  ARTIFACT_SIGNING_KEY: '12345678901234567890123456789012',
  PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example.com',
  PREVIEW_DOMAINS: 'preview.roomote.example.com',
  R_GITHUB_APP_SLUG: 'roomote-dev',
};

describe('Env', () => {
  it('loads critical runtime settings with expected types and constraints', () => {
    expect(['test', 'development', 'production']).toContain(Env.NODE_ENV);

    const databaseUrl = new URL(Env.DATABASE_URL);
    expect(['postgres:', 'postgresql:']).toContain(databaseUrl.protocol);
    expect(databaseUrl.pathname).toContain('test');

    for (const maybeNumber of [
      Env.PREVIEW_TOKEN_TTL_SECONDS,
      Env.SLACK_API_TIMEOUT_MS,
      Env.API_EXTERNAL_REQUEST_TIMEOUT_MS,
      Env.API_SLOW_REQUEST_THRESHOLD_MS,
      Env.API_SLOW_EXTERNAL_REQUEST_THRESHOLD_MS,
    ]) {
      if (typeof maybeNumber === 'undefined') {
        continue;
      }

      const parsed = Number(maybeNumber);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(0);
      expect(Number.isInteger(parsed)).toBe(true);
    }
  });

  it('preserves optional and defaulted values when creating env from a custom source', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv = { ...process.env };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.ARTIFACT_SIGNING_KEY_PREVIOUS;
    delete runtimeEnv.SANDBOX_OIDC_PUBLIC_KEY_SECONDARY;
    delete runtimeEnv.PREVIEW_TOKEN_TTL_SECONDS;
    delete runtimeEnv.SKIP_ENV_VALIDATION;
    for (const key of [
      'R_MODEL',
      'R_SMALL_MODEL',
      'R_VISION_MODEL',
      'R_CODE_REVIEW_MODEL',
      'R_EXPLORE_MODEL',
      'R_PLANNING_MODEL',
      'R_MODEL_REASONING_EFFORT',
      'R_SMALL_MODEL_REASONING_EFFORT',
      'R_VISION_MODEL_REASONING_EFFORT',
      'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
      'R_EXPLORE_MODEL_REASONING_EFFORT',
      'R_PLANNING_MODEL_REASONING_EFFORT',
      'R_MODEL_ENV_KEYS',
    ]) {
      delete runtimeEnv[key];
    }

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.ARTIFACT_SIGNING_KEY_PREVIOUS).toBeUndefined();
      expect(env.SANDBOX_OIDC_PUBLIC_KEY_SECONDARY).toBeUndefined();
      expect(env.DEFAULT_COMPUTE_PROVIDER).toBe('docker');
      expect(env.EXCLUDED_COMPUTE_PROVIDERS).toBeUndefined();
      expect(env.DOCKER_WORKER_IMAGE).toBe('roomote-worker:local');
      expect(env.DOCKER_WORKER_PLATFORM).toBe(
        process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      );
      expect(env.DOCKER_WORKER_NETWORK).toBeUndefined();
      expect(env.DOCKER_WORKER_RELEASE_PATH).toBeUndefined();
      expect(env.DOCKER_WORKER_CPU_LIMIT).toBe(2);
      expect(env.DOCKER_WORKER_MEMORY_LIMIT).toBe('4g');
      expect(env.DOCKER_TASK_DAEMON_MEMORY_LIMIT).toBe('8g');
      expect(env.DOCKER_WORKER_PIDS_LIMIT).toBe(512);
      expect(env.DOCKER_WORKER_DISK_LIMIT).toBe('20g');
      expect(env.DOCKER_WORKER_ALLOW_UNBOUNDED_DISK).toBe(false);
      expect(env.DOCKER_WORKER_LOG_MAX_SIZE).toBe('10m');
      expect(env.DOCKER_WORKER_LOG_MAX_FILES).toBe(3);
      expect(env.DOCKER_WORKER_EGRESS_POLICY).toBe('internet');
      expect(env.MODAL_VM_MEMORY_MIB).toBe(8192);
      expect(env.DOCKER_STANDBY_MAX_COUNT).toBe(10);
      expect(env.DOCKER_STANDBY_MAX_AGE_HOURS).toBe(24);
      expect(env.BLAXEL_STANDBY_MAX_COUNT).toBe(25);
      expect(env.BLAXEL_STANDBY_MAX_AGE_HOURS).toBe(168);
      expect(env.R_MODEL).toBeUndefined();
      expect(env.R_SMALL_MODEL).toBeUndefined();
      expect(env.R_VISION_MODEL).toBeUndefined();
      expect(env.R_CODE_REVIEW_MODEL).toBeUndefined();
      expect(env.R_EXPLORE_MODEL).toBeUndefined();
      expect(env.R_PLANNING_MODEL).toBeUndefined();
      expect(env.R_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_SMALL_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_VISION_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_CODE_REVIEW_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_EXPLORE_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_PLANNING_MODEL_REASONING_EFFORT).toBeUndefined();
      expect(env.R_MODEL_ENV_KEYS).toBeUndefined();
      expect(env.S3_ENDPOINT).toBe('http://localhost:19000');
      expect(env.S3_PRESIGN_ENDPOINT).toBe('http://localhost:19000');
      expect(env.S3_REGION).toBe('us-east-1');
      expect(env.S3_ACCESS_KEY_ID).toBe('roomote');
      expect(env.S3_SECRET_ACCESS_KEY).toBe('roomote-local-artifacts-password');
      expect(env.S3_BUCKET_ARTIFACTS).toBe('roomote-artifacts');
      expect(env.PREVIEW_TOKEN_TTL_SECONDS).toBe(3600);
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('requires an explicit opt-in for unbounded Docker task disks', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_WORKER_ALLOW_UNBOUNDED_DISK: 'true',
    };
    delete runtimeEnv.SKIP_ENV_VALIDATION;

    expect(
      createRoomoteEnv(runtimeEnv).DOCKER_WORKER_ALLOW_UNBOUNDED_DISK,
    ).toBe(true);
  });

  it('defaults webhook retention to three days and accepts an override', () => {
    const runtimeEnv = { ...process.env };
    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.WEBHOOK_RETENTION_DAYS;

    expect(createRoomoteEnv(runtimeEnv).WEBHOOK_RETENTION_DAYS).toBe(3);
    expect(
      createRoomoteEnv({ ...runtimeEnv, WEBHOOK_RETENTION_DAYS: '7' })
        .WEBHOOK_RETENTION_DAYS,
    ).toBe(7);
  });

  it('parses Roomote Cloud analytics configuration', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      R_CLOUD_ENABLED: '1',
      R_INTERCOM_APP_ID: 'intercom-app',
      R_POSTHOG_PROJECT_KEY: 'posthog-project',
      R_POSTHOG_HOST: 'https://eu.i.posthog.com',
    };
    delete runtimeEnv.SKIP_ENV_VALIDATION;
    const env = createRoomoteEnv(runtimeEnv);

    expect(env.R_CLOUD_ENABLED).toBe(true);
    expect(env.R_INTERCOM_APP_ID).toBe('intercom-app');
    expect(env.R_POSTHOG_PROJECT_KEY).toBe('posthog-project');
    expect(env.R_POSTHOG_HOST).toBe('https://eu.i.posthog.com');
    expect(isRoomoteCloudEnabled('true')).toBe(true);
    expect(isRoomoteCloudEnabled('1')).toBe(true);
    expect(isRoomoteCloudEnabled('false')).toBe(false);
  });

  it('enables curated integrations by default and accepts an operator override', () => {
    const runtimeEnv = { ...process.env };
    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.R_CURATED_INTEGRATIONS_ENABLED;

    expect(createRoomoteEnv(runtimeEnv).R_CURATED_INTEGRATIONS_ENABLED).toBe(
      true,
    );
    expect(
      createRoomoteEnv({
        ...runtimeEnv,
        R_CURATED_INTEGRATIONS_ENABLED: 'false',
      }).R_CURATED_INTEGRATIONS_ENABLED,
    ).toBe(false);
    expect(areCuratedIntegrationsEnabled(undefined)).toBe(true);
    expect(areCuratedIntegrationsEnabled('0')).toBe(false);
  });

  it('accepts valid Ping instance IDs and rejects invalid ones', () => {
    const runtimeEnv = { ...process.env };
    delete runtimeEnv.SKIP_ENV_VALIDATION;

    for (const instanceId of [
      'a'.repeat(6),
      'cloud-123',
      'instance.id:production',
      'deployment_42',
      'a'.repeat(128),
    ]) {
      expect(
        createRoomoteEnv({ ...runtimeEnv, R_INSTANCE_ID: instanceId })
          .R_INSTANCE_ID,
      ).toBe(instanceId);
    }

    for (const instanceId of [
      'short',
      'has spaces',
      'invalid/slash',
      'instance-\u00e9',
      'a'.repeat(129),
    ]) {
      expect(() =>
        createRoomoteEnv({ ...runtimeEnv, R_INSTANCE_ID: instanceId }),
      ).toThrow();
    }
  });

  it('allows the Modal VM memory allocation to be overridden', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    try {
      delete process.env.SKIP_ENV_VALIDATION;
      const env = createRoomoteEnv({
        ...process.env,
        MODAL_VM_MEMORY_MIB: '12288',
      });

      expect(env.MODAL_VM_MEMORY_MIB).toBe(12_288);
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('derives DOCKER_WORKER_IMAGE from the baked release version', () => {
    const env = createRoomoteEnv({
      ...process.env,
      DOCKER_WORKER_IMAGE: undefined,
      RELEASE_VERSION: 'v1.2.3',
    });

    expect(env.DOCKER_WORKER_IMAGE).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
  });

  it('treats an empty DOCKER_WORKER_IMAGE as unset for the derived default', () => {
    const env = createRoomoteEnv({
      ...process.env,
      DOCKER_WORKER_IMAGE: '',
      RELEASE_VERSION: 'v1.2.3',
    });

    expect(env.DOCKER_WORKER_IMAGE).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
  });

  it('honors a ROOMOTE_WORKER_IMAGE_REPO override for the derived worker image', () => {
    const env = createRoomoteEnv({
      ...process.env,
      DOCKER_WORKER_IMAGE: undefined,
      RELEASE_VERSION: 'v1.2.3',
      ROOMOTE_WORKER_IMAGE_REPO: 'registry.example.com/fork/roomote-worker',
    });

    expect(env.DOCKER_WORKER_IMAGE).toBe(
      'registry.example.com/fork/roomote-worker:v1.2.3',
    );
  });

  it('prefers an explicit DOCKER_WORKER_IMAGE over the release-derived default', () => {
    const env = createRoomoteEnv({
      ...process.env,
      DOCKER_WORKER_IMAGE: 'registry.example.com/custom/worker:pinned',
      RELEASE_VERSION: 'v1.2.3',
    });

    expect(env.DOCKER_WORKER_IMAGE).toBe(
      'registry.example.com/custom/worker:pinned',
    );
  });

  it('keeps the local worker image default for self-host and missing release versions', () => {
    for (const releaseVersion of [
      undefined,
      '',
      'self-host',
      'self-host-local',
      'self-host-production',
    ]) {
      const env = createRoomoteEnv({
        ...process.env,
        DOCKER_WORKER_IMAGE: undefined,
        RELEASE_VERSION: releaseVersion,
      });

      expect(env.DOCKER_WORKER_IMAGE).toBe('roomote-worker:local');
    }
  });

  it('accepts an explicit default compute provider override', () => {
    const env = createRoomoteEnv({
      ...process.env,
      DEFAULT_COMPUTE_PROVIDER: 'modal',
    });

    expect(env.DEFAULT_COMPUTE_PROVIDER).toBe('modal');
  });

  it('accepts explicit model config overrides', () => {
    const env = createRoomoteEnv({
      ...process.env,
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
      R_VISION_MODEL: 'openrouter/openai/gpt-5.5',
      R_CODE_REVIEW_MODEL: 'openrouter/openai/gpt-5.5',
      R_EXPLORE_MODEL: 'openrouter/openai/gpt-5.4-mini',
      R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
      R_VISION_MODEL_REASONING_EFFORT: 'low',
      R_CODE_REVIEW_MODEL_REASONING_EFFORT: 'high',
      R_EXPLORE_MODEL_REASONING_EFFORT: 'low',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
    });

    expect(env.R_MODEL).toBe('openrouter/openai/gpt-5.4');
    expect(env.R_SMALL_MODEL).toBe('openrouter/openai/gpt-5.4-mini');
    expect(env.R_VISION_MODEL).toBe('openrouter/openai/gpt-5.5');
    expect(env.R_CODE_REVIEW_MODEL).toBe('openrouter/openai/gpt-5.5');
    expect(env.R_EXPLORE_MODEL).toBe('openrouter/openai/gpt-5.4-mini');
    expect(env.R_PLANNING_MODEL).toBe('openrouter/anthropic/claude-opus-4.7');
    expect(env.R_MODEL_REASONING_EFFORT).toBe('medium');
    expect(env.R_SMALL_MODEL_REASONING_EFFORT).toBe('low');
    expect(env.R_VISION_MODEL_REASONING_EFFORT).toBe('low');
    expect(env.R_CODE_REVIEW_MODEL_REASONING_EFFORT).toBe('high');
    expect(env.R_EXPLORE_MODEL_REASONING_EFFORT).toBe('low');
    expect(env.R_PLANNING_MODEL_REASONING_EFFORT).toBe('high');
    expect(env.R_MODEL_ENV_KEYS).toBe('CUSTOM_PROVIDER_API_KEY');
  });

  it('supplies self-hosted local defaults outside production', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      R_APP_ENV: 'development',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.R_APP_URL;
    delete runtimeEnv.TRPC_URL;
    delete runtimeEnv.DATABASE_URL;
    delete runtimeEnv.REDIS_URL;
    delete runtimeEnv.PREVIEW_PROXY_BASE_URL;
    delete runtimeEnv.PREVIEW_DOMAINS;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.R_APP_URL).toBe('http://localhost:13000');
      expect(env.TRPC_URL).toBe('http://localhost:13001');
      expect(env.DATABASE_URL).toBe(
        'postgres://postgres:password@localhost:15432/roomote_development',
      );
      expect(env.REDIS_URL).toBe('redis://localhost:16379');
      expect(env.PREVIEW_PROXY_BASE_URL).toBe(
        'http://roomotepreview.localhost:18081',
      );
      expect(env.PREVIEW_DOMAINS).toBe(
        'localhost,127.0.0.1,roomotepreview.localhost',
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('requires core runtime settings in production', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv = { ...productionCoreEnv };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.DASHBOARD_PASSWORD;

    try {
      expect(() => createRoomoteEnv(runtimeEnv).DASHBOARD_PASSWORD).toThrow();
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('validates only the controller secret contract for controller images', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      APP_ENV: 'production',
      ROOMOTE_SERVICE: 'controller',
      R_APP_URL: 'https://roomote.example.com',
      TRPC_URL: 'https://api.roomote.example.com',
      DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
      REDIS_URL: 'redis://redis:6379',
      JOB_AUTH_PRIVATE_KEY: 'job-private-key',
      JOB_AUTH_PUBLIC_KEY: 'job-public-key',
      ENCRYPTION_KEY: '12345678901234567890123456789012',
    };

    const env = createRoomoteEnv(runtimeEnv);

    expect(env.DATABASE_URL).toBe(runtimeEnv.DATABASE_URL);
    expect(env.ENCRYPTION_KEY).toBe('12345678901234567890123456789012');
    expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PREVIEW_AUTH_PRIVATE_KEY).toBe('');
  });

  it('allows the preview proxy to receive public verification keys only', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      APP_ENV: 'production',
      ROOMOTE_SERVICE: 'preview-proxy',
      R_APP_URL: 'https://roomote.example.com',
      DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
      REDIS_URL: 'redis://redis:6379',
      JOB_AUTH_PUBLIC_KEY: 'job-public-key',
      PREVIEW_AUTH_PUBLIC_KEY: 'preview-public-key',
    };

    const env = createRoomoteEnv(runtimeEnv);

    expect(env.JOB_AUTH_PUBLIC_KEY).toBe('job-public-key');
    expect(env.PREVIEW_AUTH_PUBLIC_KEY).toBe('preview-public-key');
    expect(env.JOB_AUTH_PRIVATE_KEY).toBe('');
    expect(env.PREVIEW_AUTH_PRIVATE_KEY).toBe('');
  });

  it('still rejects a missing key required by the selected service', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      APP_ENV: 'production',
      ROOMOTE_SERVICE: 'controller',
      R_APP_URL: 'https://roomote.example.com',
      DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
      REDIS_URL: 'redis://redis:6379',
      JOB_AUTH_PUBLIC_KEY: 'job-public-key',
      ENCRYPTION_KEY: '12345678901234567890123456789012',
    };

    expect(() => createRoomoteEnv(runtimeEnv)).toThrow(
      'Invalid environment variables',
    );
  });

  it('does not require preview runtime settings for production startup', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv = { ...productionCoreEnv };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.PREVIEW_PROXY_BASE_URL;
    delete runtimeEnv.PREVIEW_DOMAINS;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.PREVIEW_PROXY_BASE_URL).toBe('');
      expect(env.PREVIEW_DOMAINS).toBe('');
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('requires auth keypairs in production without R_AUTO_GENERATE_KEYS', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv = { ...productionCoreEnv };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.JOB_AUTH_PRIVATE_KEY;
    delete runtimeEnv.JOB_AUTH_PUBLIC_KEY;

    try {
      expect(() => createRoomoteEnv(runtimeEnv)).toThrow(
        /JOB_AUTH_PRIVATE_KEY, JOB_AUTH_PUBLIC_KEY.*R_AUTO_GENERATE_KEYS/s,
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('does not require auth keypairs in development (auto-generated at boot)', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      R_APP_ENV: 'development',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.JOB_AUTH_PRIVATE_KEY;
    delete runtimeEnv.JOB_AUTH_PUBLIC_KEY;

    try {
      const env = createRoomoteEnv(runtimeEnv);
      // No committed keypair default ships in source; development leaves them
      // empty for the boot-time auto-generation path to fill.
      expect(env.JOB_AUTH_PRIVATE_KEY).toBe('');
      expect(env.PREVIEW_AUTH_PRIVATE_KEY).toBe('');
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('allows missing auth keypairs in production when R_AUTO_GENERATE_KEYS is enabled', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: Record<string, string | undefined> = {
      ...productionCoreEnv,
      R_AUTO_GENERATE_KEYS: 'true',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.JOB_AUTH_PRIVATE_KEY;
    delete runtimeEnv.JOB_AUTH_PUBLIC_KEY;
    delete runtimeEnv.PREVIEW_AUTH_PRIVATE_KEY;
    delete runtimeEnv.PREVIEW_AUTH_PUBLIC_KEY;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.JOB_AUTH_PRIVATE_KEY).toBe('');
      expect(env.JOB_AUTH_PUBLIC_KEY).toBe('');
      expect(env.PREVIEW_AUTH_PRIVATE_KEY).toBe('');
      expect(env.PREVIEW_AUTH_PUBLIC_KEY).toBe('');
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('does not require hosted integration credentials for production startup', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv = { ...productionCoreEnv };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.R_GITHUB_APP_ID;
    delete runtimeEnv.R_GITHUB_APP_PRIVATE_KEY;
    delete runtimeEnv.R_GITHUB_CLIENT_ID;
    delete runtimeEnv.R_GITHUB_CLIENT_SECRET;
    delete runtimeEnv.R_GITHUB_WEBHOOK_SECRET;
    delete runtimeEnv.SLACK_APP_ID;
    delete runtimeEnv.R_SLACK_CLIENT_ID;
    delete runtimeEnv.R_SLACK_CLIENT_SECRET;
    delete runtimeEnv.SLACK_REDIRECT_URI;
    delete runtimeEnv.SLACK_AUTH_URI;
    delete runtimeEnv.R_SLACK_SIGNING_SECRET;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.R_GITHUB_APP_ID).toBe('');
      expect(env.SLACK_APP_ID).toBe('');
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('derives SLACK_AUTH_URI from R_APP_URL when unset or empty', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;

    const unsetEnv = { ...productionCoreEnv };
    delete unsetEnv.SKIP_ENV_VALIDATION;
    delete unsetEnv.SLACK_AUTH_URI;

    const emptyEnv: NodeJS.ProcessEnv = {
      ...unsetEnv,
      SLACK_AUTH_URI: '',
      R_APP_URL: 'https://roomote.example.com/',
    };

    try {
      expect(createRoomoteEnv(unsetEnv).SLACK_AUTH_URI).toBe(
        'https://roomote.example.com/api/slack/auth',
      );
      // Trailing slashes on R_APP_URL must not produce a double slash.
      expect(createRoomoteEnv(emptyEnv).SLACK_AUTH_URI).toBe(
        'https://roomote.example.com/api/slack/auth',
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('derives SLACK_AUTH_URI from R_PUBLIC_URL when set ahead of loopback R_APP_URL', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...productionCoreEnv,
      R_APP_URL: 'http://localhost:3000/',
      R_PUBLIC_URL: 'https://customer.roomote.ai/',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;
    delete runtimeEnv.SLACK_AUTH_URI;

    try {
      expect(createRoomoteEnv(runtimeEnv).SLACK_AUTH_URI).toBe(
        'https://customer.roomote.ai/api/slack/auth',
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('prefers an explicit SLACK_AUTH_URI over the derived value', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...productionCoreEnv,
      SLACK_AUTH_URI: 'https://auth.example.com/slack',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.SLACK_AUTH_URI).toBe('https://auth.example.com/slack');
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('treats empty optional non-empty env vars as unset', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: Record<string, string | undefined> = {
      ...productionCoreEnv,
      R_PUBLIC_URL: '',
      R_INSTANCE_ID: '',
      R_TEAMS_BOT_APP_ID: '',
      R_TEAMS_BOT_APP_PASSWORD: '',
      R_TEAMS_BOT_TENANT_ID: '',
      R_TEAMS_BOT_NAME: '',
      R_TEAMS_BOT_TOKEN_ENDPOINT: '',
      R_TEAMS_BOT_OAUTH_SCOPE: '',
      R_TELEGRAM_BOT_TOKEN: '',
      R_TELEGRAM_WEBHOOK_SECRET: '',
      R_DISCORD_BOT_TOKEN: '',
      R_DISCORD_GATEWAY_SECRET: '',
      R_SLACK_CLIENT_ID: '',
      R_SLACK_CLIENT_SECRET: '',
      R_SLACK_SIGNING_SECRET: '',
      R_MICROSOFT_CLIENT_ID: '',
      R_MICROSOFT_CLIENT_SECRET: '',
      R_MICROSOFT_TENANT_ID: '',
      R_LINEAR_CLIENT_ID: '',
      R_LINEAR_CLIENT_SECRET: '',
      R_LINEAR_WEBHOOK_SECRET: '',
      S3_PRESIGN_ENDPOINT: '',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;

    try {
      const env = createRoomoteEnv(runtimeEnv);

      expect(env.R_PUBLIC_URL).toBeUndefined();
      expect(env.R_INSTANCE_ID).toBeUndefined();
      expect(env.R_TEAMS_BOT_APP_ID).toBeUndefined();
      expect(env.R_TEAMS_BOT_NAME).toBeUndefined();
      expect(env.R_TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.R_TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
      expect(env.R_DISCORD_BOT_TOKEN).toBeUndefined();
      expect(env.R_DISCORD_GATEWAY_SECRET).toBeUndefined();
      expect(env.R_SLACK_CLIENT_ID).toBeUndefined();
      expect(env.R_SLACK_SIGNING_SECRET).toBeUndefined();
      expect(env.R_MICROSOFT_CLIENT_ID).toBeUndefined();
      expect(env.R_MICROSOFT_TENANT_ID).toBeUndefined();
      expect(env.R_LINEAR_CLIENT_ID).toBeUndefined();
      expect(env.S3_PRESIGN_ENDPOINT).toBeUndefined();
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('exposes Discord runtime configuration to control-plane services', () => {
    const env = createRoomoteEnv({
      ...productionCoreEnv,
      R_DISCORD_BOT_TOKEN: 'discord-bot-token',
      R_DISCORD_GATEWAY_SECRET: 'discord-gateway-secret',
      DISCORD_API_BASE_URL: 'https://discord.example.test/api/v10',
    });

    expect(env.R_DISCORD_BOT_TOKEN).toBe('discord-bot-token');
    expect(env.R_DISCORD_GATEWAY_SECRET).toBe('discord-gateway-secret');
    expect(env.DISCORD_API_BASE_URL).toBe(
      'https://discord.example.test/api/v10',
    );
  });

  it('requires a tenant when Microsoft auth credentials are configured', () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const runtimeEnv: Record<string, string | undefined> = {
      ...productionCoreEnv,
      R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
      R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
    };

    delete runtimeEnv.SKIP_ENV_VALIDATION;

    try {
      expect(() => createRoomoteEnv(runtimeEnv)).toThrow(
        /R_MICROSOFT_TENANT_ID/,
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('can rehydrate the shared Env singleton from the current process env', () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const firstUrl = 'postgres://user:secret@localhost/first_test';
    const secondUrl = 'postgres://user:secret@localhost/second_test';

    try {
      process.env.DATABASE_URL = firstUrl;
      rehydrateEnv();
      expect(Env.DATABASE_URL).toBe(firstUrl);

      process.env.DATABASE_URL = secondUrl;
      rehydrateEnv();
      expect(Env.DATABASE_URL).toBe(secondUrl);
    } finally {
      if (originalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }

      rehydrateEnv();
    }
  });
});

describe('resolveAppEnv', () => {
  it('prefers explicit R_APP_ENV values', () => {
    expect(resolveAppEnv({ R_APP_ENV: 'preview' } as NodeJS.ProcessEnv)).toBe(
      'preview',
    );
  });

  it('ignores legacy APP_ENV values', () => {
    expect(resolveAppEnv({ APP_ENV: 'preview' } as NodeJS.ProcessEnv)).toBe(
      'development',
    );
  });

  it('falls back to the provided default', () => {
    expect(resolveAppEnv({} as NodeJS.ProcessEnv, 'production')).toBe(
      'production',
    );
  });
});

describe('getDefaultTrpcUrl', () => {
  it('uses the local API port for development', () => {
    expect(getDefaultTrpcUrl('development')).toBe('http://localhost:13001');
  });

  it('requires explicit API configuration for preview', () => {
    expect(() => getDefaultTrpcUrl('preview')).toThrow(
      'TRPC_URL must be configured explicitly for preview',
    );
  });

  it('requires explicit API configuration for production', () => {
    expect(() => getDefaultTrpcUrl('production')).toThrow(
      'TRPC_URL must be configured explicitly for production',
    );
  });
});

describe('getDefaultRoomoteAppUrl', () => {
  it('uses the local web port for development', () => {
    expect(getDefaultRoomoteAppUrl('development')).toBe(
      'http://localhost:13000',
    );
  });

  it('requires explicit web configuration outside development', () => {
    expect(() => getDefaultRoomoteAppUrl('preview')).toThrow(
      'R_APP_URL must be configured explicitly for preview',
    );
    expect(() => getDefaultRoomoteAppUrl('production')).toThrow(
      'R_APP_URL must be configured explicitly for production',
    );
  });
});

describe('getDefaultPreviewProxyBaseUrl', () => {
  it('uses the local preview proxy host for development', () => {
    expect(getDefaultPreviewProxyBaseUrl('development')).toBe(
      'http://roomotepreview.localhost:18081',
    );
  });

  it('requires explicit preview proxy configuration outside development', () => {
    expect(() => getDefaultPreviewProxyBaseUrl('preview')).toThrow(
      'PREVIEW_PROXY_BASE_URL must be configured explicitly for preview',
    );
    expect(() => getDefaultPreviewProxyBaseUrl('production')).toThrow(
      'PREVIEW_PROXY_BASE_URL must be configured explicitly for production',
    );
  });
});

describe('getDefaultDocsUrl', () => {
  it('uses the public docs site URL for all app environments', () => {
    expect(getDefaultDocsUrl('development')).toBe('https://docs.roomote.dev');
    expect(getDefaultDocsUrl('preview')).toBe('https://docs.roomote.dev');
    expect(getDefaultDocsUrl('production')).toBe('https://docs.roomote.dev');
  });
});

describe('getWebBundledEnvFilePaths', () => {
  it('uses the local env file for development web runtimes', () => {
    expect(getWebBundledEnvFilePaths('development')).toEqual([
      '../../.env.local',
    ]);
  });

  it('uses optional .env.local for preview builds', () => {
    expect(getWebBundledEnvFilePaths('preview')).toEqual(['../../.env.local']);
  });

  it('uses optional .env.local for production builds', () => {
    expect(getWebBundledEnvFilePaths('production')).toEqual([
      '../../.env.local',
    ]);
  });
});

describe('isAutoGenerateKeysEnabled', () => {
  it('accepts common truthy spellings', () => {
    expect(isAutoGenerateKeysEnabled('true')).toBe(true);
    expect(isAutoGenerateKeysEnabled('TRUE')).toBe(true);
    expect(isAutoGenerateKeysEnabled(' 1 ')).toBe(true);
  });

  it('treats everything else as disabled', () => {
    expect(isAutoGenerateKeysEnabled(undefined)).toBe(false);
    expect(isAutoGenerateKeysEnabled('')).toBe(false);
    expect(isAutoGenerateKeysEnabled('false')).toBe(false);
    expect(isAutoGenerateKeysEnabled('yes')).toBe(false);
  });
});

describe('getAllowedDevOrigins', () => {
  it('includes the shared localhost and tunnel defaults', () => {
    expect(getAllowedDevOrigins(undefined)).toEqual([
      'localhost',
      '127.0.0.1',
      '*.ngrok.dev',
      '*.ngrok.app',
      '*.ngrok-free.dev',
    ]);
  });

  it('adds wildcard preview domains from PREVIEW_DOMAINS', () => {
    expect(
      getAllowedDevOrigins(
        'preview.octomote.run, preview-john.ngrok.app, preview.octomote.run',
      ),
    ).toEqual([
      'localhost',
      '127.0.0.1',
      '*.ngrok.dev',
      '*.ngrok.app',
      '*.ngrok-free.dev',
      '*.preview.octomote.run',
      '*.preview-john.ngrok.app',
    ]);
  });
});

describe('shouldAutoGenerateAuthKeypairs', () => {
  it('is true for development without the explicit flag', () => {
    expect(
      shouldAutoGenerateAuthKeypairs({
        R_APP_ENV: 'development',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('is false for production without the explicit flag', () => {
    expect(
      shouldAutoGenerateAuthKeypairs({
        R_APP_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('is true for production when R_AUTO_GENERATE_KEYS is set', () => {
    expect(
      shouldAutoGenerateAuthKeypairs({
        R_APP_ENV: 'production',
        R_AUTO_GENERATE_KEYS: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('is false in development under NODE_ENV=test without the flag', () => {
    expect(
      shouldAutoGenerateAuthKeypairs({
        R_APP_ENV: 'development',
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('still honors the explicit flag under NODE_ENV=test', () => {
    expect(
      shouldAutoGenerateAuthKeypairs({
        R_APP_ENV: 'development',
        NODE_ENV: 'test',
        R_AUTO_GENERATE_KEYS: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('isExposedBindHost', () => {
  it('treats unset and loopback hosts as not exposed', () => {
    expect(isExposedBindHost(undefined)).toBe(false);
    expect(isExposedBindHost('')).toBe(false);
    expect(isExposedBindHost('localhost')).toBe(false);
    expect(isExposedBindHost('127.0.0.1')).toBe(false);
    expect(isExposedBindHost('::1')).toBe(false);
  });

  it('treats bind-all and routable hosts as exposed', () => {
    expect(isExposedBindHost('0.0.0.0')).toBe(true);
    expect(isExposedBindHost('10.0.0.5')).toBe(true);
    expect(isExposedBindHost('app.example.com')).toBe(true);
  });
});

describe('getActiveInsecureLocalSecrets', () => {
  it('flags each committed local default that is still in effect', () => {
    expect(
      getActiveInsecureLocalSecrets({
        ENCRYPTION_KEY: LOCAL_ENCRYPTION_KEY,
        ARTIFACT_SIGNING_KEY: LOCAL_ARTIFACT_SIGNING_KEY,
        DASHBOARD_PASSWORD: LOCAL_DASHBOARD_PASSWORD,
      }),
    ).toEqual(['ENCRYPTION_KEY', 'ARTIFACT_SIGNING_KEY', 'DASHBOARD_PASSWORD']);
  });

  it('flags nothing when real secrets are supplied', () => {
    expect(
      getActiveInsecureLocalSecrets({
        ENCRYPTION_KEY: 'a-real-encryption-key-value-abcdef',
        ARTIFACT_SIGNING_KEY: 'a-real-artifact-signing-key-abcdef',
        DASHBOARD_PASSWORD: 'a-real-dashboard-password',
      }),
    ).toEqual([]);
  });
});

describe('assertSecureBootBinding', () => {
  const insecureEnv = {
    ENCRYPTION_KEY: LOCAL_ENCRYPTION_KEY,
    ARTIFACT_SIGNING_KEY: LOCAL_ARTIFACT_SIGNING_KEY,
    DASHBOARD_PASSWORD: LOCAL_DASHBOARD_PASSWORD,
  };

  it('throws when local defaults are active on a non-loopback bind', () => {
    expect(() =>
      assertSecureBootBinding({
        env: insecureEnv,
        processEnv: { HOST: '0.0.0.0' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/ENCRYPTION_KEY.*non-loopback/s);
  });

  it('does not throw on a loopback bind', () => {
    expect(() =>
      assertSecureBootBinding({
        env: insecureEnv,
        processEnv: { HOST: '127.0.0.1' } as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
  });

  it('does not throw when HOST is unset (dev)', () => {
    expect(() =>
      assertSecureBootBinding({
        env: insecureEnv,
        processEnv: {} as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
  });

  it('does not throw when real secrets are supplied on an exposed bind', () => {
    expect(() =>
      assertSecureBootBinding({
        env: {
          ENCRYPTION_KEY: 'a-real-encryption-key-value-abcdef',
          ARTIFACT_SIGNING_KEY: 'a-real-artifact-signing-key-abcdef',
          DASHBOARD_PASSWORD: 'a-real-dashboard-password',
        },
        processEnv: { HOST: '0.0.0.0' } as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
  });

  it('allows an explicit override on an exposed bind', () => {
    expect(() =>
      assertSecureBootBinding({
        env: insecureEnv,
        processEnv: {
          HOST: '0.0.0.0',
          ROOMOTE_ALLOW_INSECURE_LOCAL_KEYS: '1',
        } as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
  });
});
