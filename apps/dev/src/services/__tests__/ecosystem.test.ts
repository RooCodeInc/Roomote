import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  isSettingsOnlyProviderEnvVar,
} from '@roomote/types';

const require = createRequire(import.meta.url);
const ecosystemConfigPath = fileURLToPath(
  new URL('../../../../../ecosystem.config.js', import.meta.url),
);
const productionComposePath = fileURLToPath(
  new URL(
    '../../../../../deploy/compose/docker-compose.prod.yml',
    import.meta.url,
  ),
);
const runtimeProviderEnvKeys = DEFAULT_MODEL_PROVIDER_ENV_KEYS.filter(
  (key) => !isSettingsOnlyProviderEnvVar(key),
);
const workerLauncherEnvKeys = [
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
  'CUSTOM_PROVIDER_API_KEY',
  'AZURE_RESOURCE_NAME',
  'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
  'AWS_REGION',
  'ZAI_REGION',
  'ZAI_CODING_PLAN_REGION',
] as const;

interface EcosystemApp {
  name: string;
  script?: string;
  args?: string;
  env?: Record<string, string | undefined>;
}

function loadEcosystemApps(): EcosystemApp[] {
  delete require.cache[ecosystemConfigPath];
  return require(ecosystemConfigPath).apps as EcosystemApp[];
}

describe('ecosystem.config.js', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete require.cache[ecosystemConfigPath];
  });

  it('loads the local service list', () => {
    process.env = { ...originalEnv };

    const apps = loadEcosystemApps();

    expect(apps.map((app) => app.name)).toEqual([
      'roomote-api',
      'roomote-web',
      'roomote-preview-proxy',
      'roomote-bullmq',
      'roomote-controller',
      'roomote-worker-release-watcher',
    ]);
  });

  it('assigns Roomote-specific local ports to app services', () => {
    process.env = { ...originalEnv };

    const apps = loadEcosystemApps();

    expect(apps.find((app) => app.name === 'roomote-web')?.env?.PORT).toBe(
      '13000',
    );
    expect(apps.find((app) => app.name === 'roomote-api')?.env?.PORT).toBe(
      '13001',
    );
    expect(apps.find((app) => app.name === 'roomote-bullmq')?.env?.PORT).toBe(
      '13002',
    );
    expect(
      apps.find((app) => app.name === 'roomote-preview-proxy')?.env?.PORT,
    ).toBe('18081');
  });

  it('starts repo services through mise-managed pnpm', () => {
    process.env = { ...originalEnv };

    const apps = loadEcosystemApps();
    const webApp = apps.find((app) => app.name === 'roomote-web');
    const workerReleaseWatcher = apps.find(
      (app) => app.name === 'roomote-worker-release-watcher',
    );

    expect(webApp).toMatchObject({
      script: 'mise',
      args: 'exec -- pnpm --filter @roomote/web dev',
    });
    expect(workerReleaseWatcher).toMatchObject({
      script: 'mise',
      args: 'exec -- pnpm --filter @roomote/dev watch-worker-release',
    });
  });

  it('defaults local services to Docker worker execution', () => {
    process.env = {
      ...originalEnv,
      DEFAULT_COMPUTE_PROVIDER: undefined,
      DOCKER_WORKER_IMAGE: undefined,
      DOCKER_WORKER_PLATFORM: undefined,
    };

    const apps = loadEcosystemApps();
    const controllerApp = apps.find((app) => app.name === 'roomote-controller');

    expect(controllerApp?.env).toMatchObject({
      DEFAULT_COMPUTE_PROVIDER: 'docker',
      DOCKER_WORKER_IMAGE: 'roomote-worker:local',
      DOCKER_WORKER_PLATFORM:
        process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    });
  });

  it('passes model config and configured provider keys to controller services', () => {
    process.env = {
      ...originalEnv,
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
      R_VISION_MODEL: 'openrouter/openai/gpt-5.5',
      R_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      CUSTOM_PROVIDER_API_KEY: 'custom-provider-key',
    };

    const apps = loadEcosystemApps();
    const controllerApp = apps.find((app) => app.name === 'roomote-controller');

    expect(controllerApp?.env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_SMALL_MODEL: 'openrouter/openai/gpt-5.4-mini',
      R_VISION_MODEL: 'openrouter/openai/gpt-5.5',
      R_MODEL_ENV_KEYS: 'CUSTOM_PROVIDER_API_KEY',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      CUSTOM_PROVIDER_API_KEY: 'custom-provider-key',
    });
  });

  it('forwards every canonical runtime provider variable in deployment templates', () => {
    process.env = {
      ...originalEnv,
      ...Object.fromEntries(runtimeProviderEnvKeys.map((key) => [key, key])),
    };

    const apps = loadEcosystemApps();
    for (const serviceName of ['api', 'web', 'bullmq', 'controller']) {
      const app = apps.find((entry) => entry.name === `roomote-${serviceName}`);

      for (const key of runtimeProviderEnvKeys) {
        expect(app?.env?.[key], `${serviceName} is missing ${key}`).toBe(key);
      }
    }

    const compose = readFileSync(productionComposePath, 'utf8');
    const inferenceEnv = compose.slice(
      compose.indexOf('x-roomote-inference-env:'),
      compose.indexOf('x-roomote-worker-launcher-env:'),
    );
    for (const key of runtimeProviderEnvKeys) {
      expect(inferenceEnv, `production Compose is missing ${key}`).toContain(
        `  ${key}: \${${key}:-}`,
      );
    }
  });

  it('gives the production controller only worker launcher model configuration', () => {
    const compose = readFileSync(productionComposePath, 'utf8');
    const workerLauncherEnv = compose.slice(
      compose.indexOf('x-roomote-worker-launcher-env:'),
      compose.indexOf('x-roomote-web-env:'),
    );
    const controllerEnv = compose.slice(
      compose.indexOf('x-roomote-controller-env:'),
      compose.indexOf('x-roomote-bullmq-env:'),
    );

    for (const key of workerLauncherEnvKeys) {
      expect(workerLauncherEnv, `worker launcher is missing ${key}`).toContain(
        `  ${key}: \${${key}:-}`,
      );
    }
    for (const key of DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES) {
      expect(
        workerLauncherEnv,
        `worker launcher must not receive provider credential ${key}`,
      ).not.toContain(`  ${key}:`);
    }
    expect(controllerEnv).toContain('  <<: *roomote-worker-launcher-env');
  });

  it('passes the preview inference launcher key only to the controller', () => {
    process.env = {
      ...originalEnv,
      SANDBOX_OPENROUTER_API_KEY: 'sandbox-openrouter-key',
    };

    const apps = loadEcosystemApps();

    expect(
      apps.find((app) => app.name === 'roomote-controller')?.env
        ?.SANDBOX_OPENROUTER_API_KEY,
    ).toBe('sandbox-openrouter-key');
    expect(
      apps
        .filter((app) => app.name !== 'roomote-controller')
        .every((app) => app.env?.SANDBOX_OPENROUTER_API_KEY === undefined),
    ).toBe(true);
  });

  it('uses R_PUBLIC_URL as the local app callback base', () => {
    process.env = {
      ...originalEnv,
      R_PUBLIC_URL: 'https://roomote-example.ngrok.app',
      S3_PRESIGN_ENDPOINT: undefined,
    };

    const apps = loadEcosystemApps();
    const webApp = apps.find((app) => app.name === 'roomote-web');
    const apiApp = apps.find((app) => app.name === 'roomote-api');

    expect(webApp?.env).toMatchObject({
      R_PUBLIC_URL: 'https://roomote-example.ngrok.app',
      R_APP_URL: 'https://roomote-example.ngrok.app',
      S3_PRESIGN_ENDPOINT: 'https://roomote-example.ngrok.app',
      SLACK_REDIRECT_URI:
        'https://roomote-example.ngrok.app/api/slack/callback',
      SLACK_AUTH_URI: 'https://roomote-example.ngrok.app/api/slack/auth',
      R_LINEAR_REDIRECT_URI:
        'https://roomote-example.ngrok.app/api/linear/callback',
    });
    expect(apiApp?.env?.S3_PRESIGN_ENDPOINT).toBe(
      'https://roomote-example.ngrok.app',
    );
  });

  it('preserves an explicit artifact presign endpoint', () => {
    process.env = {
      ...originalEnv,
      R_PUBLIC_URL: 'https://roomote-example.ngrok.app',
      S3_PRESIGN_ENDPOINT: 'https://artifacts.example.com',
    };

    const apps = loadEcosystemApps();

    expect(
      apps.find((app) => app.name === 'roomote-api')?.env?.S3_PRESIGN_ENDPOINT,
    ).toBe('https://artifacts.example.com');
  });

  it('does not include the deleted hosted listener in the PM2 app list', () => {
    process.env = { ...originalEnv };

    const apps = loadEcosystemApps();
    expect(apps.map((app) => app.name)).not.toContain(
      'roomote-hosted-listener',
    );
  });
});
