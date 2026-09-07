import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';

import {
  authSessions,
  authUsers,
  db,
  deploymentSettings,
  deploymentSecrets,
  environmentVariables,
  eq,
  inArray,
  resolveDeploymentEnvVar,
  users,
} from '@roomote/db/server';
import { encryptJSON } from '@roomote/db/encryption';
import {
  buildSetupModelStatus,
  DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
  normalizeDeploymentModelConfig,
} from '@roomote/types';

const { envMock, mockBootstrapWebRuntimeEnv, mockIsWebServerBindExposed } =
  vi.hoisted(() => ({
    envMock: {
      APP_ENV: 'development',
      R_APP_URL: 'http://localhost:3000',
      WEB_DEV_LOGIN_EMAIL: 'local@roomote.dev',
      WEB_DEV_LOGIN_ENABLED: 'true' as string | undefined,
      R_ALLOWED_EMAILS: undefined as string | undefined,
      ENCRYPTION_KEY: 'local-roomote-encryption-key-0001',
    },
    mockBootstrapWebRuntimeEnv: vi.fn(),
    mockIsWebServerBindExposed: vi.fn(() => false),
  }));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

vi.mock('@/lib/server/env', async () => ({
  Env: envMock,
  isWebServerBindExposed: mockIsWebServerBindExposed,
  isEnvFlagEnabled: (
    await vi.importActual<typeof import('@roomote/env')>('@roomote/env')
  ).isEnvFlagEnabled,
  getEncryptionKey: () => envMock.ENCRYPTION_KEY,
  getBetterAuthSecret: () => envMock.ENCRYPTION_KEY,
}));

import { GET } from './route';

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

function getSessionCookieValue(response: Response): string {
  const sessionCookie = getSetCookieHeaders(response).find((cookie) =>
    cookie.startsWith('better-auth.session_token='),
  );

  expect(sessionCookie).toBeDefined();

  const encodedValue = sessionCookie!
    .slice('better-auth.session_token='.length)
    .split(';')[0]!;

  return decodeURIComponent(encodedValue);
}

function signCookieValue(value: string): string {
  return `${value}.${createHmac('sha256', envMock.ENCRYPTION_KEY).update(value).digest('base64')}`;
}

async function deleteDevLoginRows() {
  await db
    .delete(authSessions)
    .where(eq(authSessions.userAgent, 'roomote-dev-login-test'));
  await db
    .delete(environmentVariables)
    .where(
      inArray(environmentVariables.name, [
        'ANTHROPIC_API_KEY',
        'OPENROUTER_API_KEY',
      ]),
    );
  await db
    .delete(authUsers)
    .where(eq(authUsers.email, envMock.WEB_DEV_LOGIN_EMAIL));
  await db.delete(users).where(eq(users.email, envMock.WEB_DEV_LOGIN_EMAIL));
  await db
    .delete(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'));
  await db
    .delete(deploymentSecrets)
    .where(
      inArray(deploymentSecrets.name, [
        'CHATGPT_SUBSCRIPTION_OAUTH',
        'GITHUB_COPILOT_SUBSCRIPTION_OAUTH',
        'XAI_SUBSCRIPTION_OAUTH',
      ]),
    );
}

describe('GET /auth/dev-login', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    envMock.APP_ENV = 'development';
    envMock.R_APP_URL = 'http://localhost:3000';
    envMock.WEB_DEV_LOGIN_EMAIL = 'local@roomote.dev';
    envMock.WEB_DEV_LOGIN_ENABLED = 'true';
    envMock.R_ALLOWED_EMAILS = undefined;
    mockIsWebServerBindExposed.mockReturnValue(false);
    await deleteDevLoginRows();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await deleteDevLoginRows();
  });

  it('creates a Better Auth session and redirects to the safe local path', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/auth/dev-login?redirect_url=%2Ftask%2Ftask-123',
        {
          headers: {
            'user-agent': 'roomote-dev-login-test',
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/task/task-123',
    );
    expect(mockBootstrapWebRuntimeEnv).toHaveBeenCalledTimes(1);

    const signedCookie = getSessionCookieValue(response);
    const sessionToken = signedCookie.split('.')[0]!;

    expect(signedCookie).toBe(signCookieValue(sessionToken));

    const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.token, sessionToken));

    expect(session).toMatchObject({
      userAgent: 'roomote-dev-login-test',
    });
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [authUser] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, session!.userId));

    expect(authUser).toMatchObject({
      email: 'local@roomote.dev',
      emailVerified: true,
      name: 'Local Admin',
    });
  });

  it('satisfies inference setup with an intentionally invalid saved key when configuration is empty', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: { 'user-agent': 'roomote-dev-login-test' },
      }),
    );

    expect(response.status).toBe(307);
    await expect(resolveDeploymentEnvVar('OPENROUTER_API_KEY')).resolves.toBe(
      DEV_LOGIN_INFERENCE_API_KEY_PLACEHOLDER,
    );

    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { runtimeModelConfig: true },
    });
    expect(settings?.runtimeModelConfig?.roomoteModel).toMatch(
      /^openrouter\//u,
    );
    expect(
      buildSetupModelStatus({
        runtimeEnv: {},
        persistedModelConfig: settings?.runtimeModelConfig,
        persistedEnvVarNames: ['OPENROUTER_API_KEY'],
      }).setupSatisfied,
    ).toBe(true);
  });

  it('does not overwrite an existing saved inference configuration', async () => {
    await db.insert(environmentVariables).values({
      userId: null,
      name: 'ANTHROPIC_API_KEY',
      value: 'real-saved-key',
    });
    await db.insert(deploymentSettings).values({
      id: 'default',
      runtimeModelConfig: normalizeDeploymentModelConfig({
        roomoteModel: 'anthropic/claude-sonnet-5',
      }),
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: { 'user-agent': 'roomote-dev-login-test' },
      }),
    );

    expect(response.status).toBe(307);
    await expect(resolveDeploymentEnvVar('OPENROUTER_API_KEY')).resolves.toBe(
      null,
    );
    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { runtimeModelConfig: true },
    });
    expect(settings?.runtimeModelConfig?.roomoteModel).toBe(
      'anthropic/claude-sonnet-5',
    );
  });

  it('does not add saved inference configuration when runtime configuration exists', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'real-runtime-key');

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: { 'user-agent': 'roomote-dev-login-test' },
      }),
    );

    expect(response.status).toBe(307);
    await expect(resolveDeploymentEnvVar('OPENROUTER_API_KEY')).resolves.toBe(
      null,
    );
    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { runtimeModelConfig: true },
    });
    expect(settings?.runtimeModelConfig).toBeNull();
  });

  it.each([
    'CHATGPT_SUBSCRIPTION_OAUTH',
    'GITHUB_COPILOT_SUBSCRIPTION_OAUTH',
    'XAI_SUBSCRIPTION_OAUTH',
  ])(
    'does not add placeholder configuration when %s is connected',
    async (secretName) => {
      await db.insert(deploymentSecrets).values({
        name: secretName,
        value: encryptJSON({ status: 'connected' }),
      });

      const response = await GET(
        new NextRequest('http://localhost:3000/auth/dev-login', {
          headers: { 'user-agent': 'roomote-dev-login-test' },
        }),
      );

      expect(response.status).toBe(307);
      await expect(resolveDeploymentEnvVar('OPENROUTER_API_KEY')).resolves.toBe(
        null,
      );
      const settings = await db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { runtimeModelConfig: true },
      });
      expect(settings?.runtimeModelConfig).toBeNull();
    },
  );

  it('falls back to the root path when the redirect is cross-origin', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/auth/dev-login?redirect_url=https%3A%2F%2Fevil.example%2Ftask%2Ftask-123',
        {
          headers: {
            'user-agent': 'roomote-dev-login-test',
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(getSessionCookieValue(response)).toBeTruthy();
  });

  it('rejects a dev login email that is outside the Roomote allowlist', async () => {
    envMock.R_ALLOWED_EMAILS = 'someone-else@example.com';

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: {
          'user-agent': 'roomote-dev-login-test',
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();

    const sessions = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userAgent, 'roomote-dev-login-test'));

    expect(sessions).toHaveLength(0);
  });

  it('provisions the app user as an active admin', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: {
          'user-agent': 'roomote-dev-login-test',
        },
      }),
    );

    expect(response.status).toBe(307);

    const signedCookie = getSessionCookieValue(response);
    const sessionToken = signedCookie.split('.')[0]!;
    const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.token, sessionToken));

    const [appUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, session!.userId));

    expect(appUser).toMatchObject({
      email: 'local@roomote.dev',
      role: 'admin',
      deletedAt: null,
    });
  });

  it('promotes and restores an existing app user row to an active admin', async () => {
    await db.insert(authUsers).values({
      id: 'existing-auth-user',
      name: 'Existing User',
      email: 'local@roomote.dev',
      emailVerified: true,
      image: null,
    });
    await db.insert(users).values({
      id: 'existing-auth-user',
      name: 'Existing User',
      email: 'local@roomote.dev',
      imageUrl: '',
      entity: {},
      role: 'member',
      deletedAt: new Date(),
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: {
          'user-agent': 'roomote-dev-login-test',
        },
      }),
    );

    expect(response.status).toBe(307);

    const [appUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, 'existing-auth-user'));

    expect(appUser).toMatchObject({
      role: 'admin',
      deletedAt: null,
    });
  });

  it('sets the Secure cookie attribute behind an https proxy', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: {
          'user-agent': 'roomote-dev-login-test',
          'x-forwarded-host': 'task123-web.preview.roomote.run',
          'x-forwarded-proto': 'https',
        },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://task123-web.preview.roomote.run/',
    );

    // Better Auth uses the non-prefixed cookie name even for HTTPS in
    // non-production (dynamic baseURL with protocol: "auto"), but the
    // Secure attribute must still be set so the browser only sends the
    // cookie over HTTPS.
    const sessionCookie = getSetCookieHeaders(response).find((cookie) =>
      cookie.startsWith('better-auth.session_token='),
    );

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('Secure');
  });

  it('reuses an existing auth user without overwriting its display name', async () => {
    await db.insert(authUsers).values({
      id: 'existing-auth-user',
      name: 'Existing User',
      email: 'local@roomote.dev',
      emailVerified: true,
      image: null,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login', {
        headers: {
          'user-agent': 'roomote-dev-login-test',
        },
      }),
    );

    expect(response.status).toBe(307);

    const signedCookie = getSessionCookieValue(response);
    const sessionToken = signedCookie.split('.')[0]!;
    const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.token, sessionToken));

    expect(session?.userId).toBe('existing-auth-user');

    const [authUser] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, 'existing-auth-user'));

    expect(authUser?.name).toBe('Existing User');
  });

  it.each(['preview', 'production'] as const)(
    'is not available in %s app envs',
    async (appEnv) => {
      envMock.APP_ENV = appEnv;

      const response = await GET(
        new NextRequest('http://localhost:3000/auth/dev-login'),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('set-cookie')).toBeNull();
      await expect(
        resolveDeploymentEnvVar('OPENROUTER_API_KEY'),
      ).resolves.toBeNull();
    },
  );

  it.each([undefined, '', 'false', '0'])(
    'is not available when WEB_DEV_LOGIN_ENABLED is %j',
    async (flagValue) => {
      envMock.WEB_DEV_LOGIN_ENABLED = flagValue;

      const response = await GET(
        new NextRequest('http://localhost:3000/auth/dev-login'),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );

  it('is not available when the web server binds a non-loopback interface', async () => {
    mockIsWebServerBindExposed.mockReturnValue(true);

    const response = await GET(
      new NextRequest('http://localhost:3000/auth/dev-login'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
