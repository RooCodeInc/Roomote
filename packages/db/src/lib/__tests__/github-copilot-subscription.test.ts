import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

import {
  pollGitHubCopilotDeviceAuth,
  resolveGitHubCopilotOAuthClientId,
  startGitHubCopilotDeviceAuth,
} from '../github-copilot-subscription';

function makeExecutor() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { executor: { insert } as never, values };
}

describe('GitHub Copilot device authorization', () => {
  it("defaults to OpenCode's client id and accepts a deployment override", () => {
    expect(resolveGitHubCopilotOAuthClientId({})).toBe('Ov23li8tweQw6odWQebz');
    expect(
      resolveGitHubCopilotOAuthClientId({
        GITHUB_COPILOT_OAUTH_CLIENT_ID: ' roomote-client-id ',
      }),
    ).toBe('roomote-client-id');
  });

  it('starts the same device-code flow used by OpenCode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      ),
    );

    await expect(startGitHubCopilotDeviceAuth(fetchImpl)).resolves.toEqual({
      deviceCode: 'device-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://github.com/login/device',
      intervalMs: 5_000,
      expiresInMs: 900_000,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      client_id: 'Ov23li8tweQw6odWQebz',
      scope: 'read:user',
    });
  });

  it('starts device authorization with the configured client id', async () => {
    vi.stubEnv('GITHUB_COPILOT_OAUTH_CLIENT_ID', 'roomote-client-id');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          interval: 5,
        }),
        { status: 200 },
      ),
    );

    try {
      await startGitHubCopilotDeviceAuth(fetchImpl);
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).client_id).toBe('roomote-client-id');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports pending authorization without storing a credential', async () => {
    const { executor, values } = makeExecutor();
    const result = await pollGitHubCopilotDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'authorization_pending' }), {
            status: 200,
          }),
        ),
      },
    );

    expect(result).toEqual({ status: 'pending' });
    expect(values).not.toHaveBeenCalled();
  });

  it('encrypts and stores the long-lived GitHub OAuth token after approval', async () => {
    const { executor, values } = makeExecutor();
    const result = await pollGitHubCopilotDeviceAuth(
      { deviceCode: 'device-1' },
      {
        executor,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ access_token: 'gho-secret' }), {
            status: 200,
          }),
        ),
      },
    );

    expect(result).toEqual({ status: 'success' });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'GITHUB_COPILOT_SUBSCRIPTION_OAUTH',
        value: expect.stringContaining('gho-secret'),
      }),
    );
  });
});
