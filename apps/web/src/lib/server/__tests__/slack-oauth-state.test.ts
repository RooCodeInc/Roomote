import { encodeRecord } from '@/lib/url-coder';

vi.mock('@roomote/db/server', () => ({
  resolveSlackSigningSecret: vi.fn(async () => 'test-signing-secret'),
}));

import {
  createSignedSlackInstallState,
  createSignedSlackLinkAccountState,
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

  it('round-trips signed link-account state bound to the initiating user', async () => {
    const state = await createSignedSlackLinkAccountState({
      userId: 'user-abc',
      redirectPath: '/settings/profile',
    });

    await expect(decodeSlackOAuthState(state)).resolves.toEqual({
      mode: 'link_account',
      redirectPath: '/settings/profile',
      userId: 'user-abc',
    });
  });

  it('rejects unsigned link-account state', async () => {
    const state = encodeRecord({
      mode: 'link_account',
      redirect: '/settings/profile',
    });

    await expect(decodeSlackOAuthState(state)).resolves.toBeNull();
  });

  it('normalizes unsafe link-account redirects via signing path', async () => {
    const state = await createSignedSlackLinkAccountState({
      userId: 'user-abc',
      redirectPath: 'https://evil.example.com',
    });

    await expect(decodeSlackOAuthState(state)).resolves.toEqual({
      mode: 'link_account',
      redirectPath: '/settings',
      userId: 'user-abc',
    });
  });
});
