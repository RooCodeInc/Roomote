import { encodeRecord } from '@/lib/url-coder';

vi.mock('@roomote/db/server', () => ({
  resolveSlackSigningSecret: vi.fn(async () => 'test-signing-secret'),
}));

import {
  createSignedSlackInstallState,
  decodeSlackOAuthState,
} from '../slack-oauth-state';

describe('slack-oauth-state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips signed install state', async () => {
    const state = await createSignedSlackInstallState({
      redirectPath: '/settings/integrations',
    });

    await expect(decodeSlackOAuthState(state)).resolves.toEqual({
      mode: 'install',
      redirectPath: '/settings/integrations',
    });
  });

  it('rejects tampered install state', async () => {
    const state = await createSignedSlackInstallState({
      redirectPath: '/settings',
    });
    const [payload, signature] = state.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        mode: 'install',
        redirectPath: '/settings/integrations',
        issuedAt: Date.now(),
      }),
    ).toString('base64url');

    expect(signature).toBeTruthy();
    await expect(
      decodeSlackOAuthState(`${tamperedPayload}.${signature}`),
    ).resolves.toBeNull();
    await expect(decodeSlackOAuthState(payload)).resolves.toBeNull();
  });

  it('still decodes link-account state without trusting unsafe redirects', async () => {
    const state = encodeRecord({
      mode: 'link_account',
      redirect: 'https://evil.example.com',
    });

    await expect(decodeSlackOAuthState(state)).resolves.toEqual({
      mode: 'link_account',
      redirectPath: '/settings',
    });
  });
});
