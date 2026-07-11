import { execa } from 'execa';

import { runDoctor } from '../doctor';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const originalFetch = global.fetch;
const originalEnv = process.env;
const mockedExeca = execa as unknown as {
  mockImplementation: (
    implementation: (
      command: string,
      args?: string[],
    ) => Promise<{ stdout: string }>,
  ) => void;
};

interface MockPorts {
  web?: string;
  api?: string;
  bullmq?: string;
  previewProxy?: string;
}

function getPortEnv(ports: MockPorts): Record<string, string> {
  return {
    ...(ports.web ? { ROOMOTE_WEB_PORT: ports.web } : {}),
    ...(ports.api ? { ROOMOTE_API_PORT: ports.api } : {}),
    ...(ports.bullmq ? { ROOMOTE_BULLMQ_PORT: ports.bullmq } : {}),
    ...(ports.previewProxy
      ? { ROOMOTE_PREVIEW_PROXY_PORT: ports.previewProxy }
      : {}),
  };
}

function mockResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

function mockFetch(
  status = 200,
  options: { teamsTokenStatus?: number; teamsCallbackStatus?: number } = {},
) {
  global.fetch = vi
    .fn()
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes('/oauth2/v2.0/token')) {
        const tokenStatus = options.teamsTokenStatus ?? 200;

        return mockResponse(
          tokenStatus >= 200 && tokenStatus < 300
            ? { access_token: 'teams-bot-token', expires_in: 3600 }
            : { error: 'invalid_client' },
          tokenStatus,
        );
      }

      if (url.endsWith('/api/webhooks/teams')) {
        return mockResponse(
          { ok: false, error: 'invalid_teams_activity' },
          options.teamsCallbackStatus ?? 400,
        );
      }

      return mockResponse({}, status);
    });
}

function mockExeca({
  containers = ['roomote-postgres', 'roomote-redis', 'roomote-minio'],
  pm2Status = 'online',
  publicUrl = 'https://roomote-matt.ngrok.app',
  publicUrlLocation = 'nested',
  runtimeTooling = true,
  includeDefaultAuth = true,
  extraWebEnv = {},
  ports = {},
}: {
  containers?: string[];
  pm2Status?: string;
  publicUrl?: string;
  publicUrlLocation?: 'nested' | 'top-level';
  runtimeTooling?: boolean;
  includeDefaultAuth?: boolean;
  extraWebEnv?: Record<string, string | undefined>;
  ports?: MockPorts;
} = {}) {
  const webEnv = {
    R_PUBLIC_URL: publicUrl,
    ...(includeDefaultAuth
      ? {
          R_SLACK_CLIENT_ID: 'slack-client-id',
          R_SLACK_CLIENT_SECRET: 'slack-client-secret',
        }
      : {}),
    R_MODEL: 'openrouter/openai/gpt-5.4',
    OPENROUTER_API_KEY: 'openrouter-key',
    ...getPortEnv(ports),
    ...extraWebEnv,
  };
  const webEnvEntries = Object.entries(webEnv)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);

  mockedExeca.mockImplementation(async (command, args) => {
    if (
      args?.[0] === '--version' &&
      (command === 'opencode' || command === 'python3')
    ) {
      if (!runtimeTooling) {
        const error = new Error(`spawn ${command} ENOENT`) as Error & {
          code?: string;
        };
        error.code = 'ENOENT';
        throw error;
      }

      return { stdout: `${command} 0.0.0` };
    }

    if (command === 'docker' && args?.[0] === 'ps') {
      return {
        stdout: containers.join('\n'),
      };
    }

    if (command === 'docker' && args?.[0] === 'inspect') {
      return {
        stdout: JSON.stringify(webEnvEntries),
      };
    }

    if (command === 'pm2' && args?.includes('jlist')) {
      return {
        stdout: JSON.stringify([
          ...[
            'roomote-api',
            'roomote-web',
            'roomote-preview-proxy',
            'roomote-bullmq',
            'roomote-controller',
            'roomote-worker-release-watcher',
          ].map((name) => ({
            name,
            ...(name === 'roomote-web' && publicUrlLocation === 'top-level'
              ? webEnv
              : {}),
            pm2_env: {
              status: pm2Status,
              env:
                name === 'roomote-web' && publicUrlLocation === 'nested'
                  ? webEnv
                  : {},
            },
          })),
        ]),
      };
    }

    throw new Error(`Unexpected command: ${command} ${args?.join(' ')}`);
  });
}

describe('runDoctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockExeca();
    mockFetch();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('passes when containers, services, endpoints, and required config are healthy', async () => {
    const checks = await runDoctor();

    expect(checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('reads PM2 process env values from the top-level PM2 payload', async () => {
    mockExeca({ publicUrlLocation: 'top-level' });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Public callback URL',
        status: 'pass',
        detail: 'https://roomote-matt.ngrok.app',
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'Auth providers', status: 'pass' }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'Model config', status: 'pass' }),
    );
  });

  it('recognizes Vercel AI Gateway credentials from the shared provider metadata', async () => {
    mockExeca({
      extraWebEnv: {
        R_MODEL: 'vercel/openai/gpt-5.4',
        OPENROUTER_API_KEY: undefined,
        AI_GATEWAY_API_KEY: 'vercel-key',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Model config',
        status: 'pass',
        detail: 'R_MODEL configured with vercel credentials',
      }),
    );
  });

  it('accepts Microsoft Teams as a complete auth provider', async () => {
    mockExeca({
      includeDefaultAuth: false,
      extraWebEnv: {
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
        R_MICROSOFT_TENANT_ID: 'microsoft-tenant-id',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Auth providers',
        status: 'pass',
        detail: 'Microsoft Teams',
      }),
    );
  });

  it('warns when Microsoft Teams auth is missing its tenant ID', async () => {
    mockExeca({
      includeDefaultAuth: false,
      extraWebEnv: {
        R_MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        R_MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Auth providers',
        status: 'warn',
        detail: 'incomplete Microsoft Teams client ID/secret/tenant set',
      }),
    );
  });

  it('warns when Teams bot config is missing required credentials', async () => {
    mockExeca({
      extraWebEnv: {
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams bot config',
        status: 'warn',
        detail: 'incomplete Teams bot config; missing R_TEAMS_BOT_APP_PASSWORD',
      }),
    );
  });

  it('warns when the Teams bot token endpoint is not an absolute URL', async () => {
    mockExeca({
      extraWebEnv: {
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'teams-bot-secret',
        R_TEAMS_BOT_TOKEN_ENDPOINT: 'not-a-url',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams bot config',
        status: 'warn',
        detail: 'R_TEAMS_BOT_TOKEN_ENDPOINT must be an absolute URL',
      }),
    );
  });

  it('checks live Teams bot token exchange and public callback reachability', async () => {
    mockExeca({
      extraWebEnv: {
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'teams-bot-secret',
        R_TEAMS_BOT_TENANT_ID: 'teams-tenant-id',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams Azure Bot token',
        status: 'pass',
        detail:
          'https://login.microsoftonline.com/teams-tenant-id/oauth2/v2.0/token',
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams app callback',
        status: 'pass',
        detail: expect.stringContaining(
          'Azure Bot messaging endpoint https://roomote-matt.ngrok.app/api/webhooks/teams',
        ),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/teams-tenant-id/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://roomote-matt.ngrok.app/api/webhooks/teams',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('warns when live Teams bot token exchange fails', async () => {
    mockFetch(200, { teamsTokenStatus: 401 });
    mockExeca({
      extraWebEnv: {
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'teams-bot-secret',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams Azure Bot token',
        status: 'warn',
        detail: expect.stringContaining('token request failed with 401'),
      }),
    );
  });

  it('warns when the public Teams webhook callback is not reachable', async () => {
    mockFetch(200, { teamsCallbackStatus: 404 });
    mockExeca({
      extraWebEnv: {
        R_TEAMS_BOT_APP_ID: 'teams-bot-app-id',
        R_TEAMS_BOT_APP_PASSWORD: 'teams-bot-secret',
      },
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Teams app callback',
        status: 'warn',
        detail: expect.stringContaining('returned 404'),
      }),
    );
  });

  it('warns when the configured model provider key is missing', async () => {
    mockedExeca.mockImplementation(async (command, args) => {
      if (command === 'docker') {
        return {
          stdout: 'roomote-postgres\nroomote-redis\nroomote-minio',
        };
      }

      if (command === 'pm2' && args?.includes('jlist')) {
        return {
          stdout: JSON.stringify([
            ...[
              'roomote-api',
              'roomote-web',
              'roomote-preview-proxy',
              'roomote-bullmq',
              'roomote-controller',
              'roomote-worker-release-watcher',
            ].map((name) => ({
              name,
              pm2_env: {
                status: 'online',
                env:
                  name === 'roomote-web'
                    ? {
                        R_PUBLIC_URL: 'https://roomote-matt.ngrok.app',
                        R_SLACK_CLIENT_ID: 'slack-client-id',
                        R_SLACK_CLIENT_SECRET: 'slack-client-secret',
                        R_MODEL: 'openrouter/openai/gpt-5.4',
                      }
                    : {},
              },
            })),
          ]),
        };
      }

      throw new Error(`Unexpected command: ${command} ${args?.join(' ')}`);
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Model config',
        status: 'warn',
        detail: 'R_MODEL configured; missing OPENROUTER_API_KEY',
      }),
    );
  });

  it('warns when task runtime tooling is missing from PATH', async () => {
    mockExeca({ runtimeTooling: false });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Task runtime tooling',
        status: 'warn',
        detail: expect.stringContaining('OpenCode CLI'),
      }),
    );
  });

  it('checks configured service ports from the runtime env', async () => {
    mockExeca({
      ports: {
        web: '13100',
        api: '13101',
        bullmq: '13102',
        previewProxy: '18181',
      },
    });

    await runDoctor();

    const fetchedUrls = vi
      .mocked(global.fetch)
      .mock.calls.map(([url]) => String(url));

    expect(fetchedUrls).toEqual(
      expect.arrayContaining([
        'http://localhost:13100/sign-in',
        'http://localhost:13101/health/liveness',
        'http://localhost:13101/health/api',
        'http://localhost:13101/health/controller',
        'http://localhost:18181/health',
        'http://localhost:13102/admin/health',
      ]),
    );
    expect(fetchedUrls).not.toContain('http://localhost:13000/sign-in');
  });

  it('fails when a required Docker container is missing', async () => {
    mockExeca({ containers: ['roomote-postgres'] });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Docker containers',
        status: 'fail',
        detail: expect.stringContaining('roomote-redis'),
      }),
    );
  });

  it('passes when self-host Compose containers are running instead of PM2 services', async () => {
    mockExeca({
      containers: [
        'roomote-postgres',
        'roomote-redis',
        'roomote-minio',
        'roomote-api',
        'roomote-web',
        'roomote-preview-proxy',
        'roomote-bullmq',
        'roomote-controller',
      ],
      pm2Status: 'offline',
      publicUrl: 'https://self-host.ngrok-free.app',
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Runtime services',
        status: 'pass',
        detail: expect.stringContaining('self-host Compose runtime'),
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Public callback URL',
        status: 'pass',
        detail: 'https://self-host.ngrok-free.app',
      }),
    );
    expect(checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('warns when sign-in and model providers are not configured yet', async () => {
    mockExeca({ publicUrl: 'https://roomote-matt.ngrok.app' });
    mockedExeca.mockImplementation(async (command, args) => {
      if (command === 'docker') {
        return {
          stdout: 'roomote-postgres\nroomote-redis\nroomote-minio',
        };
      }

      if (command === 'pm2' && args?.includes('jlist')) {
        return {
          stdout: JSON.stringify([
            ...[
              'roomote-api',
              'roomote-web',
              'roomote-preview-proxy',
              'roomote-bullmq',
              'roomote-controller',
              'roomote-worker-release-watcher',
            ].map((name) => ({
              name,
              pm2_env: {
                status: 'online',
                env:
                  name === 'roomote-web'
                    ? {
                        R_PUBLIC_URL: 'https://roomote-matt.ngrok.app',
                      }
                    : {},
              },
            })),
          ]),
        };
      }

      throw new Error(`Unexpected command: ${command} ${args?.join(' ')}`);
    });
    delete process.env.R_SLACK_CLIENT_ID;
    delete process.env.R_SLACK_CLIENT_SECRET;
    delete process.env.R_SLACK_CLIENT_ID;
    delete process.env.R_SLACK_CLIENT_SECRET;
    delete process.env.R_MODEL;

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'Auth providers', status: 'warn' }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ name: 'Model config', status: 'warn' }),
    );
  });

  it('warns when an auth provider has only a client ID or secret configured', async () => {
    process.env.R_SLACK_CLIENT_SECRET = 'shell-secret';

    mockedExeca.mockImplementation(async (command, args) => {
      if (command === 'docker') {
        return {
          stdout: 'roomote-postgres\nroomote-redis\nroomote-minio',
        };
      }

      if (command === 'pm2' && args?.includes('jlist')) {
        return {
          stdout: JSON.stringify([
            ...[
              'roomote-api',
              'roomote-web',
              'roomote-preview-proxy',
              'roomote-bullmq',
              'roomote-controller',
              'roomote-worker-release-watcher',
            ].map((name) => ({
              name,
              pm2_env: {
                status: 'online',
                env:
                  name === 'roomote-web'
                    ? {
                        R_PUBLIC_URL: 'https://roomote-matt.ngrok.app',
                        R_SLACK_CLIENT_ID: 'slack-client-id',
                        R_MODEL: 'openrouter/openai/gpt-5.4',
                        OPENROUTER_API_KEY: 'openrouter-key',
                      }
                    : {},
              },
            })),
          ]),
        };
      }

      throw new Error(`Unexpected command: ${command} ${args?.join(' ')}`);
    });

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'Auth providers',
        status: 'warn',
        detail: 'incomplete Slack client ID/secret pair',
      }),
    );
  });

  it('fails when an HTTP health endpoint returns a non-2xx response', async () => {
    mockFetch(503);

    const checks = await runDoctor();

    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'web sign-in',
        status: 'fail',
        detail: expect.stringContaining('503'),
      }),
    );
  });
});
