const { mockEnvState } = vi.hoisted(() => ({
  mockEnvState: { SETUP_TOKEN: undefined as string | undefined },
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {},
  desc: vi.fn(),
  eq: vi.fn(),
  invites: {},
  isNull: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
  users: {},
}));

vi.mock('../env', () => ({
  Env: new Proxy(
    {},
    {
      get: (_target, prop) => mockEnvState[prop as keyof typeof mockEnvState],
    },
  ),
}));

import {
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  isInviteUsable,
  isSystemInviteToken,
} from '../invites';

describe('invite tokens', () => {
  it('hashes deterministically and generates url-safe tokens', () => {
    const token = generateInviteToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    expect(hashInviteToken(token)).not.toBe(token);
  });

  it('builds invite urls on the app origin', () => {
    expect(buildInviteUrl('https://roomote.example.com', 'abc_123')).toBe(
      'https://roomote.example.com/invite/abc_123',
    );
  });
});

describe('isInviteUsable', () => {
  const base = {
    revokedAt: null,
    expiresAt: null,
    usedCount: 0,
    maxUses: 1,
  };

  it('accepts live invites and rejects revoked, expired, and exhausted ones', () => {
    expect(isInviteUsable(base)).toBe(true);
    expect(isInviteUsable({ ...base, revokedAt: new Date() })).toBe(false);
    expect(
      isInviteUsable({ ...base, expiresAt: new Date(Date.now() - 1000) }),
    ).toBe(false);
    expect(
      isInviteUsable({ ...base, expiresAt: new Date(Date.now() + 60_000) }),
    ).toBe(true);
    expect(isInviteUsable({ ...base, usedCount: 1 })).toBe(false);
    expect(isInviteUsable({ ...base, usedCount: 1, maxUses: 5 })).toBe(true);
  });
});

describe('isSystemInviteToken', () => {
  afterEach(() => {
    mockEnvState.SETUP_TOKEN = undefined;
  });

  it('matches only the configured setup token', () => {
    expect(isSystemInviteToken('anything')).toBe(false);

    mockEnvState.SETUP_TOKEN = 'setup-secret';
    expect(isSystemInviteToken('setup-secret')).toBe(true);
    expect(isSystemInviteToken('wrong')).toBe(false);
    expect(isSystemInviteToken(null)).toBe(false);
  });
});
