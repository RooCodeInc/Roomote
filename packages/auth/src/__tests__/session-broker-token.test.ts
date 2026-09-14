import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  configureAuthClientEnv,
  createAuthToken,
  createRunToken,
  createMcpAccessToken,
  createSessionBrokerToken,
  validateAuthToken,
  validateRunToken,
  validateMcpAccessToken,
  validateSessionBrokerToken,
} from '../index';

const keys = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const identity = {
  userId: 'test-session-owner',
  fastConversationId: randomUUID(),
};

beforeAll(() =>
  configureAuthClientEnv({
    jobAuthPrivateKey: keys.privateKey,
    jobAuthPublicKey: keys.publicKey,
  }),
);
afterAll(() => configureAuthClientEnv(null));
afterEach(() => vi.useRealTimers());

it('signs a dedicated two-minute ES256 capability containing only owner and Fast context', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
  const token = await createSessionBrokerToken(identity);
  const verified = jwt.verify(token, keys.publicKey, {
    algorithms: ['ES256'],
    issuer: 'rcc',
    audience: 'roomote-session-broker',
  });
  expect(verified).toEqual({
    iss: 'rcc',
    sub: identity.userId,
    aud: 'roomote-session-broker',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    r: { t: 'session-broker', c: identity.fastConversationId },
  });
  expect(await validateSessionBrokerToken(token)).toEqual({
    tokenType: 'session-broker',
    ...identity,
  });
  vi.setSystemTime(Date.now() + 120_000);
  await expect(validateSessionBrokerToken(token)).rejects.toThrow(
    'jwt expired',
  );
});

it('does not interchange broker tokens with ordinary auth, run or public MCP tokens', async () => {
  const token = await createSessionBrokerToken(identity);
  for (const validate of [
    validateAuthToken,
    validateRunToken,
    validateMcpAccessToken,
  ])
    await expect(validate(token)).rejects.toThrow();
  for (const ordinary of [
    await createAuthToken({ userId: identity.userId, timeoutMs: 60_000 }),
    await createRunToken({
      runId: 123,
      userId: identity.userId,
      timeoutMs: 60_000,
    }),
    await createMcpAccessToken({
      userId: identity.userId,
      resource: 'https://api.example.com/mcp',
      scopes: ['mcp:roomote'],
      timeoutMs: 60_000,
    }),
  ])
    await expect(validateSessionBrokerToken(ordinary)).rejects.toThrow();
});

it.each([
  { iss: 'other' },
  { aud: 'https://api.example.com/mcp' },
  { sub: '' },
  { exp: undefined },
  { exp: 1 },
  { r: { t: 'auth', c: identity.fastConversationId } },
  { r: { t: 'session-broker', c: 'not-a-uuid' } },
  { r: { t: 'session-broker', sessionId: randomUUID() } },
])('rejects correctly signed but invalid claims %j', async (overrides) => {
  const payload = {
    iss: 'rcc',
    sub: identity.userId,
    aud: 'roomote-session-broker',
    exp: Math.floor(Date.now() / 1000) + 120,
    r: { t: 'session-broker', c: identity.fastConversationId },
    ...overrides,
  };
  const token = jwt.sign(
    Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ),
    keys.privateKey,
    { algorithm: 'ES256' },
  );
  await expect(validateSessionBrokerToken(token)).rejects.toThrow();
});

it('rejects tampered signatures and unsigned tokens', async () => {
  const token = await createSessionBrokerToken(identity);
  const [header, payload, signature] = token.split('.') as [
    string,
    string,
    string,
  ];
  const changedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await expect(
    validateSessionBrokerToken(`${header}.${payload}.${changedSignature}`),
  ).rejects.toThrow();
  const unsigned = jwt.sign({ sub: identity.userId }, '', {
    algorithm: 'none',
  });
  await expect(validateSessionBrokerToken(unsigned)).rejects.toThrow();
});

it.each([{ userId: '' }, { fastConversationId: 'caller-session-id' }])(
  'rejects invalid minting context %j',
  async (overrides) => {
    await expect(
      createSessionBrokerToken({ ...identity, ...overrides }),
    ).rejects.toThrow();
  },
);
