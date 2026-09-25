import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnv, resolveEffectiveDeploymentEnvVarsMock } = vi.hoisted(() => ({
  mockEnv: {
    R_CLOUD_ENABLED: undefined as string | undefined,
    R_LICENSE_KEY: undefined as string | undefined,
    R_LICENSE_CLOUD_BASE_URL: 'https://cloud.example.test/',
  },
  resolveEffectiveDeploymentEnvVarsMock: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/env')>()),
  Env: mockEnv,
}));

vi.mock('./deployment-license', () => ({
  getEnvLicenseKey: () => mockEnv.R_LICENSE_KEY?.trim() || null,
}));

vi.mock('./model-runtime-config', () => ({
  resolveEffectiveDeploymentEnvVars: resolveEffectiveDeploymentEnvVarsMock,
}));

import {
  canSendAgentMailWithRuntimeCredentials,
  invalidateAgentMailRuntimeCredentialsCache,
  isAgentMailCloudManaged,
  resolveAgentMailRuntimeCredentials,
} from './agentmail-runtime-credentials';

const cloudCredentials = {
  apiKey: 'am_inbox_key',
  inboxId: 'Acme@Roomote.me',
  webhookSecret: 'whsec_1',
};

function cloudResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveAgentMailRuntimeCredentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    invalidateAgentMailRuntimeCredentialsCache();
    delete process.env.R_AGENTMAIL_API_KEY;
    delete process.env.R_AGENTMAIL_INBOX_ID;
    delete process.env.R_AGENTMAIL_WEBHOOK_SECRET;
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    mockEnv.R_CLOUD_ENABLED = 'true';
    mockEnv.R_LICENSE_KEY = 'RMLK1.payload.signature';
    resolveEffectiveDeploymentEnvVarsMock.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('never calls Cloud when the environment already has credentials', async () => {
    process.env.R_AGENTMAIL_API_KEY = 'env_key';
    process.env.R_AGENTMAIL_INBOX_ID = 'Env@Example.com';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'env_secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      resolveAgentMailRuntimeCredentials({ allocate: true }),
    ).resolves.toEqual({
      apiKey: 'env_key',
      inboxId: 'env@example.com',
      webhookSecret: 'env_secret',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads existing Cloud credentials without allocating', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(cloudResponse(200, cloudCredentials));

    await expect(resolveAgentMailRuntimeCredentials()).resolves.toEqual({
      apiKey: 'am_inbox_key',
      inboxId: 'acme@roomote.me',
      webhookSecret: 'whsec_1',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://cloud.example.test/api/v1/managed-email/credentials',
    );
    expect(init?.headers).toMatchObject({
      Authorization: 'License RMLK1.payload.signature',
    });
    expect(JSON.parse(String(init?.body))).toEqual({ allocate: false });
  });

  it('allocates on a send after a read found no inbox', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(cloudResponse(404, { code: 'not_allocated' }))
      .mockResolvedValueOnce(cloudResponse(200, cloudCredentials));

    await expect(resolveAgentMailRuntimeCredentials()).resolves.toEqual({
      apiKey: null,
      inboxId: null,
      webhookSecret: null,
    });
    // The cached miss does not stop a send from allocating.
    await expect(
      resolveAgentMailRuntimeCredentials({ allocate: true }),
    ).resolves.toMatchObject({ apiKey: 'am_inbox_key' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      allocate: true,
    });
    // And the allocated credentials are cached for later reads.
    await resolveAgentMailRuntimeCredentials();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one allocation across concurrent sends and backs off after a failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(cloudResponse(503, { code: 'unavailable' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await Promise.all([
      resolveAgentMailRuntimeCredentials({ allocate: true }),
      resolveAgentMailRuntimeCredentials({ allocate: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      resolveAgentMailRuntimeCredentials({ allocate: true }),
    ).resolves.toMatchObject({ apiKey: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call Cloud for self-hosted deployments', async () => {
    mockEnv.R_CLOUD_ENABLED = undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      resolveAgentMailRuntimeCredentials({ allocate: true }),
    ).resolves.toMatchObject({ apiKey: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAgentMailCloudManaged()).toBe(false);
    await expect(canSendAgentMailWithRuntimeCredentials()).resolves.toBe(false);
  });

  it('counts an unallocated Cloud inbox as available without allocating it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(canSendAgentMailWithRuntimeCredentials()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
