import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import {
  getModelProviderEnvKeyCandidates,
  resolveModelProviderIdFromModel,
} from '@roomote/types';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

const REQUIRED_INFRA_CONTAINERS = [
  'roomote-postgres',
  'roomote-redis',
  'roomote-minio',
];
const REQUIRED_SELF_HOST_CONTAINERS = [
  'roomote-api',
  'roomote-web',
  'roomote-preview-proxy',
  'roomote-bullmq',
  'roomote-controller',
];
const REQUIRED_PM2_SERVICES = [
  'roomote-api',
  'roomote-web',
  'roomote-preview-proxy',
  'roomote-bullmq',
  'roomote-controller',
];
const OPTIONAL_PM2_SERVICES = ['roomote-worker-release-watcher'];
const REQUIRED_RUNTIME_TOOLING: readonly {
  name: string;
  command: string;
  args: string[];
}[] = [
  { name: 'OpenCode CLI (opencode)', command: 'opencode', args: ['--version'] },
  { name: 'python3', command: 'python3', args: ['--version'] },
];
const DEFAULT_ROOMOTE_WEB_PORT = '13000';
const DEFAULT_ROOMOTE_API_PORT = '13001';
const DEFAULT_ROOMOTE_BULLMQ_PORT = '13002';
const DEFAULT_ROOMOTE_PREVIEW_PROXY_PORT = '18081';
const TEAMS_BOT_ENV_KEYS = [
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
  'R_TEAMS_BOT_TENANT_ID',
  'R_TEAMS_BOT_TOKEN_ENDPOINT',
  'R_TEAMS_BOT_OAUTH_SCOPE',
] as const;
const TEAMS_BOT_REQUIRED_ENV_KEYS = [
  'R_TEAMS_BOT_APP_ID',
  'R_TEAMS_BOT_APP_PASSWORD',
] as const;
const DEFAULT_R_TEAMS_BOT_OAUTH_SCOPE = 'https://api.botframework.com/.default';

interface Pm2Process {
  name: string;
  [key: string]: unknown;
  pm2_env?: {
    env?: Record<string, string | undefined>;
    status?: string;
  };
}

function formatCheck(check: DoctorCheck): string {
  const marker =
    check.status === 'pass'
      ? 'PASS'
      : check.status === 'warn'
        ? 'WARN'
        : 'FAIL';

  return `[${marker}] ${check.name}: ${check.detail}`;
}

async function listDockerContainers(): Promise<string[]> {
  const { stdout } = await execa('docker', ['ps', '--format', '{{.Names}}']);

  return stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
}

async function getDockerContainerEnv(
  containerName: string,
): Promise<Record<string, string | undefined>> {
  const { stdout } = await execa('docker', [
    'inspect',
    '--format',
    '{{json .Config.Env}}',
    containerName,
  ]);
  const entries = JSON.parse(stdout) as string[];

  return Object.fromEntries(
    entries
      .map((entry) => {
        const separatorIndex = entry.indexOf('=');

        if (separatorIndex === -1) {
          return null;
        }

        return [
          entry.slice(0, separatorIndex),
          entry.slice(separatorIndex + 1),
        ];
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );
}

async function listPm2Processes(): Promise<Pm2Process[]> {
  const { stdout } = await execa('pm2', ['--silent', 'jlist']);
  return JSON.parse(stdout) as Pm2Process[];
}

function getPm2WebEnv(
  processes: Pm2Process[],
): Record<string, string | undefined> {
  const webProcess = processes.find(
    (process) =>
      process.name === 'roomote-web' && process.pm2_env?.status === 'online',
  );

  if (!webProcess) {
    return {};
  }

  const topLevelEnv = Object.fromEntries(
    Object.entries(webProcess).filter(
      ([_, value]) => typeof value === 'string' || typeof value === 'undefined',
    ),
  ) as Record<string, string | undefined>;

  return {
    ...topLevelEnv,
    ...(webProcess.pm2_env?.env ?? {}),
  };
}

async function checkDocker(): Promise<{
  check: DoctorCheck;
  containers: string[];
}> {
  try {
    const containers = await listDockerContainers();
    const missing = REQUIRED_INFRA_CONTAINERS.filter(
      (container) => !containers.includes(container),
    );

    if (missing.length > 0) {
      return {
        check: {
          name: 'Docker containers',
          status: 'fail',
          detail: `missing ${missing.join(', ')}; run pnpm db:up or pnpm dev`,
        },
        containers,
      };
    }

    return {
      check: {
        name: 'Docker containers',
        status: 'pass',
        detail: REQUIRED_INFRA_CONTAINERS.join(', '),
      },
      containers,
    };
  } catch (error) {
    return {
      check: {
        name: 'Docker containers',
        status: 'fail',
        detail: `Docker is unavailable: ${formatError(error)}`,
      },
      containers: [],
    };
  }
}

async function checkPm2(): Promise<{
  check: DoctorCheck;
  processes: Pm2Process[];
}> {
  try {
    const processes = await listPm2Processes();
    const missing = REQUIRED_PM2_SERVICES.filter(
      (service) => !processes.some((process) => process.name === service),
    );
    const offline = REQUIRED_PM2_SERVICES.filter((service) =>
      processes.some(
        (process) =>
          process.name === service && process.pm2_env?.status !== 'online',
      ),
    );

    if (missing.length > 0 || offline.length > 0) {
      return {
        check: {
          name: 'PM2 services',
          status: 'fail',
          detail: [
            missing.length > 0 ? `missing ${missing.join(', ')}` : '',
            offline.length > 0 ? `offline ${offline.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        },
        processes,
      };
    }

    const missingOptional = OPTIONAL_PM2_SERVICES.filter(
      (service) => !processes.some((process) => process.name === service),
    );

    return {
      check: {
        name: 'PM2 services',
        status: missingOptional.length > 0 ? 'warn' : 'pass',
        detail:
          missingOptional.length > 0
            ? `core services online; optional ${missingOptional.join(', ')} missing`
            : 'core services online',
      },
      processes,
    };
  } catch (error) {
    return {
      check: {
        name: 'PM2 services',
        status: 'fail',
        detail: `PM2 is unavailable: ${formatError(error)}`,
      },
      processes: [],
    };
  }
}

function checkSelfHostContainers(containers: string[]): DoctorCheck {
  const missing = REQUIRED_SELF_HOST_CONTAINERS.filter(
    (container) => !containers.includes(container),
  );

  if (missing.length > 0) {
    return {
      name: 'Self-host containers',
      status: 'fail',
      detail: `missing ${missing.join(', ')}`,
    };
  }

  return {
    name: 'Self-host containers',
    status: 'pass',
    detail: 'application containers running',
  };
}

function checkRuntimeServices({
  pm2,
  selfHost,
}: {
  pm2: DoctorCheck;
  selfHost: DoctorCheck;
}): DoctorCheck {
  if (pm2.status !== 'fail') {
    return {
      name: 'Runtime services',
      status: pm2.status,
      detail: `PM2 dev runtime: ${pm2.detail}`,
    };
  }

  if (selfHost.status === 'pass') {
    return {
      name: 'Runtime services',
      status: 'pass',
      detail: `self-host Compose runtime: ${selfHost.detail}`,
    };
  }

  return {
    name: 'Runtime services',
    status: 'fail',
    detail: `PM2 dev runtime unavailable (${pm2.detail}); self-host Compose unavailable (${selfHost.detail})`,
  };
}

async function checkEndpoint({
  name,
  url,
}: {
  name: string;
  url: string;
}): Promise<DoctorCheck> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return {
        name,
        status: 'fail',
        detail: `${url} returned ${response.status}`,
      };
    }

    return {
      name,
      status: 'pass',
      detail: url,
    };
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: `${url} failed: ${formatError(error)}`,
    };
  }
}

function getConfiguredPort({
  env,
  keys,
  fallback,
}: {
  env: Record<string, string | undefined>;
  keys: readonly string[];
  fallback: string;
}): string {
  const value = keys
    .map((key) => env[key] ?? process.env[key])
    .find((candidate) => candidate?.trim());
  const normalizedValue = value?.trim();

  if (!normalizedValue || !/^\d+$/u.test(normalizedValue)) {
    return fallback;
  }

  return normalizedValue;
}

function getHealthEndpoints(
  env: Record<string, string | undefined>,
): { name: string; url: string }[] {
  const webPort = getConfiguredPort({
    env,
    keys: ['ROOMOTE_WEB_PORT'],
    fallback: DEFAULT_ROOMOTE_WEB_PORT,
  });
  const apiPort = getConfiguredPort({
    env,
    keys: ['ROOMOTE_API_PORT'],
    fallback: DEFAULT_ROOMOTE_API_PORT,
  });
  const bullmqPort = getConfiguredPort({
    env,
    keys: ['ROOMOTE_BULLMQ_PORT'],
    fallback: DEFAULT_ROOMOTE_BULLMQ_PORT,
  });
  const previewProxyPort = getConfiguredPort({
    env,
    keys: ['ROOMOTE_PREVIEW_PROXY_PORT'],
    fallback: DEFAULT_ROOMOTE_PREVIEW_PROXY_PORT,
  });

  return [
    { name: 'web sign-in', url: `http://localhost:${webPort}/sign-in` },
    {
      name: 'api liveness',
      url: `http://localhost:${apiPort}/health/liveness`,
    },
    {
      name: 'api dependencies',
      url: `http://localhost:${apiPort}/health/api`,
    },
    {
      name: 'controller health',
      url: `http://localhost:${apiPort}/health/controller`,
    },
    {
      name: 'preview proxy',
      url: `http://localhost:${previewProxyPort}/health`,
    },
    {
      name: 'bullmq health',
      url: `http://localhost:${bullmqPort}/admin/health`,
    },
  ];
}

async function getRuntimeEnv({
  processes,
  containers,
}: {
  processes: Pm2Process[];
  containers: string[];
}): Promise<Record<string, string | undefined>> {
  const pm2Env = getPm2WebEnv(processes);

  if (Object.keys(pm2Env).length > 0) {
    return pm2Env;
  }

  if (!containers.includes('roomote-web')) {
    return {};
  }

  try {
    return await getDockerContainerEnv('roomote-web');
  } catch {
    return {};
  }
}

function checkPublicUrl(env: Record<string, string | undefined>): DoctorCheck {
  const publicUrl = env.R_PUBLIC_URL ?? process.env.R_PUBLIC_URL;

  if (!publicUrl) {
    return {
      name: 'Public callback URL',
      status: 'warn',
      detail:
        'R_PUBLIC_URL not found in current shell, PM2 web env, or self-host web container env',
    };
  }

  try {
    const parsed = new URL(publicUrl);

    if (parsed.protocol !== 'https:') {
      return {
        name: 'Public callback URL',
        status: 'fail',
        detail: `${publicUrl} must use https`,
      };
    }

    return {
      name: 'Public callback URL',
      status: 'pass',
      detail: parsed.origin,
    };
  } catch {
    return {
      name: 'Public callback URL',
      status: 'fail',
      detail: `${publicUrl} is not a valid absolute URL`,
    };
  }
}

function checkAuthProviders(
  env: Record<string, string | undefined>,
): DoctorCheck {
  const configuredProviders: string[] = [];
  const incompleteProviders: string[] = [];
  const configEnv = Object.keys(env).length > 0 ? env : process.env;
  const hasValue = (key: string) => Boolean(configEnv[key]);
  const checkProvider = ({
    name,
    requiredKeyGroups,
    incompleteLabel,
  }: {
    name: string;
    requiredKeyGroups: string[][];
    incompleteLabel: string;
  }) => {
    const configuredGroups = requiredKeyGroups.filter((keys) =>
      keys.some(hasValue),
    );

    if (configuredGroups.length === requiredKeyGroups.length) {
      configuredProviders.push(name);
      return;
    }

    if (configuredGroups.length > 0) {
      incompleteProviders.push(`${name} ${incompleteLabel}`);
    }
  };

  checkProvider({
    name: 'Slack',
    requiredKeyGroups: [['R_SLACK_CLIENT_ID'], ['R_SLACK_CLIENT_SECRET']],
    incompleteLabel: 'client ID/secret pair',
  });
  checkProvider({
    name: 'Microsoft Teams',
    requiredKeyGroups: [
      ['R_MICROSOFT_CLIENT_ID'],
      ['R_MICROSOFT_CLIENT_SECRET'],
      ['R_MICROSOFT_TENANT_ID'],
    ],
    incompleteLabel: 'client ID/secret/tenant set',
  });

  if (configuredProviders.length > 0 && incompleteProviders.length === 0) {
    return {
      name: 'Auth providers',
      status: 'pass',
      detail: configuredProviders.join(', '),
    };
  }

  if (incompleteProviders.length > 0) {
    return {
      name: 'Auth providers',
      status: 'warn',
      detail: [
        configuredProviders.length > 0
          ? `configured ${configuredProviders.join(', ')}`
          : '',
        `incomplete ${incompleteProviders.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; '),
    };
  }

  return {
    name: 'Auth providers',
    status: 'warn',
    detail: 'configure Slack or Microsoft Teams before signing in',
  };
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function getConfigEnv(env: Record<string, string | undefined>) {
  return Object.keys(env).length > 0 ? env : process.env;
}

function getTeamsBotConfigState(env: Record<string, string | undefined>): {
  configEnv: Record<string, string | undefined>;
  configuredBotKeys: string[];
  missingRequiredKeys: string[];
  tokenEndpoint?: string;
  tokenEndpointError?: string;
} {
  const configEnv = getConfigEnv(env);
  const configuredBotKeys = TEAMS_BOT_ENV_KEYS.filter((key) =>
    Boolean(configEnv[key]?.trim()),
  );
  const missingRequiredKeys = TEAMS_BOT_REQUIRED_ENV_KEYS.filter(
    (key) => !configEnv[key]?.trim(),
  );
  const tokenEndpoint = configEnv.R_TEAMS_BOT_TOKEN_ENDPOINT?.trim();

  if (tokenEndpoint) {
    try {
      new URL(tokenEndpoint);
    } catch {
      return {
        configEnv,
        configuredBotKeys,
        missingRequiredKeys,
        tokenEndpoint,
        tokenEndpointError:
          'R_TEAMS_BOT_TOKEN_ENDPOINT must be an absolute URL',
      };
    }
  }

  return {
    configEnv,
    configuredBotKeys,
    missingRequiredKeys,
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}

function getDefaultTeamsBotTokenEndpoint(tenantId?: string): string {
  return `https://login.microsoftonline.com/${
    tenantId?.trim() || 'botframework.com'
  }/oauth2/v2.0/token`;
}

function checkTeamsBotConfig(
  env: Record<string, string | undefined>,
): DoctorCheck {
  const {
    configEnv,
    configuredBotKeys,
    missingRequiredKeys,
    tokenEndpointError,
  } = getTeamsBotConfigState(env);

  if (configuredBotKeys.length === 0) {
    return {
      name: 'Teams bot config',
      status: 'pass',
      detail: 'not configured; only required for Teams message callbacks',
    };
  }

  if (missingRequiredKeys.length > 0) {
    return {
      name: 'Teams bot config',
      status: 'warn',
      detail: `incomplete Teams bot config; missing ${missingRequiredKeys.join(', ')}`,
    };
  }

  if (tokenEndpointError) {
    return {
      name: 'Teams bot config',
      status: 'warn',
      detail: tokenEndpointError,
    };
  }

  return {
    name: 'Teams bot config',
    status: 'pass',
    detail: configEnv.R_TEAMS_BOT_TENANT_ID
      ? 'bot app ID/password configured with tenant-specific token flow'
      : 'bot app ID/password configured',
  };
}

async function checkTeamsBotTokenExchange(
  env: Record<string, string | undefined>,
): Promise<DoctorCheck> {
  const {
    configEnv,
    configuredBotKeys,
    missingRequiredKeys,
    tokenEndpoint,
    tokenEndpointError,
  } = getTeamsBotConfigState(env);

  if (configuredBotKeys.length === 0) {
    return {
      name: 'Teams Azure Bot token',
      status: 'pass',
      detail: 'not configured; only required for Teams message callbacks',
    };
  }

  if (missingRequiredKeys.length > 0) {
    return {
      name: 'Teams Azure Bot token',
      status: 'warn',
      detail: `skipped; incomplete Teams bot config; missing ${missingRequiredKeys.join(', ')}`,
    };
  }

  if (tokenEndpointError) {
    return {
      name: 'Teams Azure Bot token',
      status: 'warn',
      detail: `skipped; ${tokenEndpointError}`,
    };
  }

  const endpoint =
    tokenEndpoint ??
    getDefaultTeamsBotTokenEndpoint(configEnv.R_TEAMS_BOT_TENANT_ID);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: configEnv.R_TEAMS_BOT_APP_ID!.trim(),
    client_secret: configEnv.R_TEAMS_BOT_APP_PASSWORD!.trim(),
    scope:
      configEnv.R_TEAMS_BOT_OAUTH_SCOPE?.trim() ||
      DEFAULT_R_TEAMS_BOT_OAUTH_SCOPE,
  });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const responseBody = await readResponseText(response);

      return {
        name: 'Teams Azure Bot token',
        status: 'warn',
        detail: `token request failed with ${response.status}${
          responseBody ? `: ${responseBody}` : ''
        }`,
      };
    }

    const tokenResponse = (await response.json()) as unknown;
    const accessToken =
      tokenResponse &&
      typeof tokenResponse === 'object' &&
      typeof (tokenResponse as Record<string, unknown>).access_token ===
        'string'
        ? (tokenResponse as Record<string, string>).access_token
        : '';

    if (!accessToken) {
      return {
        name: 'Teams Azure Bot token',
        status: 'warn',
        detail: 'token response did not include access_token',
      };
    }

    return {
      name: 'Teams Azure Bot token',
      status: 'pass',
      detail: endpoint,
    };
  } catch (error) {
    return {
      name: 'Teams Azure Bot token',
      status: 'warn',
      detail: `token request failed: ${formatError(error)}`,
    };
  }
}

async function checkTeamsAppCallback(
  env: Record<string, string | undefined>,
): Promise<DoctorCheck> {
  const { configEnv, configuredBotKeys, missingRequiredKeys } =
    getTeamsBotConfigState(env);

  if (configuredBotKeys.length === 0) {
    return {
      name: 'Teams app callback',
      status: 'pass',
      detail: 'not configured; only required for Teams message callbacks',
    };
  }

  if (missingRequiredKeys.length > 0) {
    return {
      name: 'Teams app callback',
      status: 'warn',
      detail: `skipped; incomplete Teams bot config; missing ${missingRequiredKeys.join(', ')}`,
    };
  }

  const publicUrl = configEnv.R_PUBLIC_URL?.trim();

  if (!publicUrl) {
    return {
      name: 'Teams app callback',
      status: 'warn',
      detail:
        'R_PUBLIC_URL is required to configure the Azure Bot messaging endpoint',
    };
  }

  let callbackUrl: URL;

  try {
    callbackUrl = new URL('/api/webhooks/teams', publicUrl);
  } catch {
    return {
      name: 'Teams app callback',
      status: 'warn',
      detail: 'R_PUBLIC_URL must be an absolute HTTPS URL',
    };
  }

  if (callbackUrl.protocol !== 'https:') {
    return {
      name: 'Teams app callback',
      status: 'warn',
      detail: 'Teams requires an HTTPS Azure Bot messaging endpoint',
    };
  }

  try {
    const response = await fetch(callbackUrl.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    if (response.status !== 400 && response.status !== 401) {
      return {
        name: 'Teams app callback',
        status: 'warn',
        detail: `${callbackUrl.toString()} returned ${response.status}; expected 400 or 401 from the Teams webhook route`,
      };
    }

    return {
      name: 'Teams app callback',
      status: 'pass',
      detail: `Azure Bot messaging endpoint ${callbackUrl.toString()}; Teams app validDomains: ${callbackUrl.hostname}`,
    };
  } catch (error) {
    return {
      name: 'Teams app callback',
      status: 'warn',
      detail: `${callbackUrl.toString()} failed: ${formatError(error)}`,
    };
  }
}

function checkModelProviders(
  env: Record<string, string | undefined>,
): DoctorCheck {
  const configEnv = Object.keys(env).length > 0 ? env : process.env;
  const model = configEnv.R_MODEL?.trim();

  if (!model) {
    return {
      name: 'Model config',
      status: 'warn',
      detail: 'local tasks need R_MODEL',
    };
  }

  const provider = resolveModelProviderIdFromModel(model)?.toLowerCase();

  if (!provider) {
    return {
      name: 'Model config',
      status: 'fail',
      detail: 'R_MODEL must use provider/model format',
    };
  }

  const providerKeyCandidates = getModelProviderEnvKeyCandidates({
    providerId: provider,
    configuredEnvKeys: configEnv.R_MODEL_ENV_KEYS,
  });
  const hasProviderKey = providerKeyCandidates.some((key) =>
    Boolean(configEnv[key]?.trim()),
  );

  if (!hasProviderKey) {
    return {
      name: 'Model config',
      status: 'warn',
      detail:
        providerKeyCandidates.length > 0
          ? `R_MODEL configured; missing ${providerKeyCandidates.join(' or ')}`
          : 'R_MODEL configured; set R_MODEL_ENV_KEYS for this provider key',
    };
  }

  return {
    name: 'Model config',
    status: 'pass',
    detail: `R_MODEL configured with ${provider} credentials`,
  };
}

async function isCommandAvailable(
  command: string,
  args: string[],
): Promise<boolean> {
  try {
    await execa(command, args);
    return true;
  } catch (error) {
    // ENOENT means the binary is not on PATH. Any other failure means the
    // command exists but exited non-zero, which still counts as installed.
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;

    return code !== 'ENOENT';
  }
}

async function checkRuntimeTooling(): Promise<DoctorCheck> {
  const availability = await Promise.all(
    REQUIRED_RUNTIME_TOOLING.map(async (tool) => ({
      tool,
      available: await isCommandAvailable(tool.command, tool.args),
    })),
  );
  const missing = availability
    .filter((entry) => !entry.available)
    .map((entry) => entry.tool.name);

  if (missing.length > 0) {
    return {
      name: 'Task runtime tooling',
      status: 'warn',
      detail: `missing ${missing.join(', ')} on PATH; tasks run model calls through the OpenCode CLI via a python3 helper, so task creation hangs without them`,
    };
  }

  return {
    name: 'Task runtime tooling',
    status: 'pass',
    detail: REQUIRED_RUNTIME_TOOLING.map((tool) => tool.command).join(', '),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const docker = await checkDocker();
  checks.push(docker.check);

  const pm2 = await checkPm2();
  const selfHost = checkSelfHostContainers(docker.containers);
  checks.push(checkRuntimeServices({ pm2: pm2.check, selfHost }));

  const runtimeEnv = await getRuntimeEnv({
    processes: pm2.processes,
    containers: docker.containers,
  });
  checks.push(checkPublicUrl(runtimeEnv));
  checks.push(checkAuthProviders(runtimeEnv));
  checks.push(checkTeamsBotConfig(runtimeEnv));
  checks.push(await checkTeamsBotTokenExchange(runtimeEnv));
  checks.push(await checkTeamsAppCallback(runtimeEnv));
  checks.push(checkModelProviders(runtimeEnv));
  checks.push(await checkRuntimeTooling());

  const endpointChecks = await Promise.all(
    getHealthEndpoints(runtimeEnv).map(checkEndpoint),
  );
  checks.push(...endpointChecks);

  return checks;
}

async function main(): Promise<void> {
  const checks = await runDoctor();

  for (const check of checks) {
    console.info(formatCheck(check));
  }

  const failed = checks.filter((check) => check.status === 'fail');

  if (failed.length > 0) {
    console.error(`\nRoomote doctor found ${failed.length} failing check(s).`);
    process.exit(1);
  }

  console.info('\nRoomote doctor completed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
}
