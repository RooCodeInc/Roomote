import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ecosystemConfigPath = fileURLToPath(
  new URL('../../../../../ecosystem.config.js', import.meta.url),
);

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

  it('passes explicitly activated Roomote Cloud runtime values to local services', () => {
    process.env = {
      ...originalEnv,
      ROOMOTE_CLOUD_ENABLED: 'true',
      ROOMOTE_CLOUD_URL: 'http://localhost:4100',
      ROOMOTE_CLOUD_DEPLOYMENT_TOKEN: 'deployment-token',
      ROOMOTE_CLOUD_DEPLOYMENT_ID: 'deployment-id',
      ROOMOTE_CLOUD_INTEGRATION_SECRET: 'integration-secret',
    };

    const apps = loadEcosystemApps();
    const controllerApp = apps.find((app) => app.name === 'roomote-controller');

    expect(controllerApp?.env).toMatchObject({
      ROOMOTE_CLOUD_ENABLED: 'true',
      ROOMOTE_CLOUD_URL: 'http://localhost:4100',
      ROOMOTE_CLOUD_DEPLOYMENT_TOKEN: 'deployment-token',
      ROOMOTE_CLOUD_DEPLOYMENT_ID: 'deployment-id',
      ROOMOTE_CLOUD_INTEGRATION_SECRET: 'integration-secret',
    });
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
