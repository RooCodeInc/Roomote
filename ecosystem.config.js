/*global process, module*/

const useWorkerRelease = process.env.USE_WORKER_RELEASE === 'true';
const DEFAULT_OPENCODE_PROVIDER_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'OPENCODE_API_KEY',
  'BASETEN_API_KEY',
  'TOGETHER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_VERTEX_PROJECT',
  'GOOGLE_VERTEX_LOCATION',
];
const OPENCODE_RUNTIME_ENV_KEYS = [
  'R_MODEL',
  'R_SMALL_MODEL',
  'R_VISION_MODEL',
  'R_CODE_REVIEW_MODEL',
  'R_EXPLORE_MODEL',
  'R_MODEL_ENV_KEYS',
  'OPENCODE_COMMAND',
  'OPENCODE_PTY_PYTHON_COMMAND',
];
const localPorts = {
  web: Number(process.env.ROOMOTE_WEB_PORT || 13000),
  api: Number(process.env.ROOMOTE_API_PORT || 13001),
  bullmq: Number(process.env.ROOMOTE_BULLMQ_PORT || 13002),
  previewProxy: Number(process.env.ROOMOTE_PREVIEW_PROXY_PORT || 18081),
};
const publicUrl = process.env.R_PUBLIC_URL;

const configuredModelProviderEnvKeysValue = process.env.R_MODEL_ENV_KEYS || '';
const configuredModelProviderEnvKeys = configuredModelProviderEnvKeysValue
  ? configuredModelProviderEnvKeysValue
      .split(/[,\s]+/u)
      .map((key) => key.trim())
      .filter(Boolean)
  : [];
const openCodeEnv = Object.fromEntries(
  [
    ...OPENCODE_RUNTIME_ENV_KEYS,
    ...DEFAULT_OPENCODE_PROVIDER_ENV_KEYS,
    ...configuredModelProviderEnvKeys,
  ].map((key) => [key, process.env[key]]),
);

const defaultEnv = {
  PORT: undefined,
  USE_WORKER_RELEASE: process.env.USE_WORKER_RELEASE,
  R_DEFAULT_COMPUTE_PROVIDER:
    process.env.R_DEFAULT_COMPUTE_PROVIDER || 'docker',
  R_DOCKER_WORKER_IMAGE:
    process.env.R_DOCKER_WORKER_IMAGE || 'roomote-worker:local',
  // Host arch, so Apple Silicon dev machines run the worker natively.
  R_DOCKER_WORKER_PLATFORM:
    process.env.R_DOCKER_WORKER_PLATFORM ||
    (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'),
  R_PUBLIC_URL: publicUrl,
  R_APP_URL: publicUrl,
  // Set by `pnpm dev` to `<public-url>/_roomote-api` so workers on hosted
  // compute providers reach the API through the Caddy dev edge, matching
  // the deployed R_TRPC_URL contract.
  R_TRPC_URL: process.env.R_TRPC_URL,

  // GitHub app credentials:
  R_GITHUB_APP_SLUG: process.env.R_GITHUB_APP_SLUG,
  R_GITHUB_APP_ID: process.env.R_GITHUB_APP_ID,
  R_GITHUB_APP_PRIVATE_KEY: process.env.R_GITHUB_APP_PRIVATE_KEY,
  R_GITHUB_CLIENT_ID: process.env.R_GITHUB_CLIENT_ID,
  R_GITHUB_CLIENT_SECRET: process.env.R_GITHUB_CLIENT_SECRET,
  R_GITHUB_WEBHOOK_SECRET: process.env.R_GITHUB_WEBHOOK_SECRET,

  // Slack app credentials:
  R_SLACK_APP_ID: process.env.R_SLACK_APP_ID,
  R_SLACK_CLIENT_ID: process.env.R_SLACK_CLIENT_ID,
  R_SLACK_CLIENT_SECRET: process.env.R_SLACK_CLIENT_SECRET,
  R_SLACK_REDIRECT_URI: publicUrl
    ? `${publicUrl}/api/slack/callback`
    : undefined,
  R_SLACK_AUTH_URI: publicUrl ? `${publicUrl}/api/slack/auth` : undefined,
  R_SLACK_SIGNING_SECRET: process.env.R_SLACK_SIGNING_SECRET,

  // Linear app credentials:
  R_LINEAR_CLIENT_ID: process.env.R_LINEAR_CLIENT_ID,
  R_LINEAR_CLIENT_SECRET: process.env.R_LINEAR_CLIENT_SECRET,
  R_LINEAR_REDIRECT_URI: publicUrl
    ? `${publicUrl}/api/linear/callback`
    : undefined,
  R_LINEAR_WEBHOOK_SECRET: process.env.R_LINEAR_WEBHOOK_SECRET,

  ...openCodeEnv,
};

const env = defaultEnv;

const defaults = {
  cwd: process.cwd(),
  watch: false,
  autorestart: true,
  max_restarts: 5,
  min_uptime: '10s',
  time: true,
};

const logFiles = (name) => ({
  log_file: `./logs/${name}.log`,
  error_file: `./logs/${name}-error.log`,
  out_file: `./logs/${name}-out.log`,
});

const app = (name, opts = {}) => ({
  name: `roomote-${name}`,
  script: 'mise',
  args: `exec -- pnpm --filter @roomote/${name} dev`,
  ...logFiles(`roomote-${name}`),
  ...defaults,
  env,
  ...opts,
});

const apps = [
  app('api', { env: { ...env, PORT: String(localPorts.api) } }),
  app('web', {
    env: {
      ...env,
      PORT: String(localPorts.web),
      // Dev login requires an explicit opt-in on top of the development app
      // env. `pnpm dev` is the intended local flow, so enable it here unless
      // the operator overrides it.
      WEB_DEV_LOGIN_ENABLED: process.env.WEB_DEV_LOGIN_ENABLED || 'true',
    },
  }),
  app('preview-proxy', {
    env: { ...env, PORT: String(localPorts.previewProxy) },
  }),
  app('bullmq', { env: { ...env, PORT: String(localPorts.bullmq) } }),
  app('controller', { startup_delay: 15000 }),
];

if (!useWorkerRelease) {
  apps.push({
    name: 'roomote-worker-release-watcher',
    script: 'mise',
    args: 'exec -- pnpm --filter @roomote/dev watch-worker-release',
    ...logFiles('roomote-worker-release-watcher'),
    ...defaults,
    env,
  });
}

module.exports = { apps };
