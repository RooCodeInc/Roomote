vi.mock('@roomote/db/server', () => ({
  db: {},
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn(),
}));

import { generateKeyPairSync, sign } from 'node:crypto';

import {
  FREE_SEAT_LIMIT,
  resolveLicenseState,
  verifyLicenseKey,
} from '../license';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeySpkiB64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

function issueKey(payload: Record<string, unknown>): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKey);

  return `RMLK1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}

const validPayload = {
  licenseId: 'lic_test123',
  licensee: 'Acme Corp',
  maxSeats: 50,
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
};

describe('verifyLicenseKey', () => {
  it('accepts a correctly signed key', () => {
    const payload = verifyLicenseKey(issueKey(validPayload), publicKeySpkiB64);

    expect(payload).toMatchObject({
      licenseId: 'lic_test123',
      licensee: 'Acme Corp',
      maxSeats: 50,
      expiresAt: null,
    });
    expect(payload?.issuedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('tolerates surrounding whitespace', () => {
    expect(
      verifyLicenseKey(`  ${issueKey(validPayload)}\n`, publicKeySpkiB64),
    ).not.toBeNull();
  });

  it('rejects a key whose payload was tampered with', () => {
    const [prefix, , signature] = issueKey(validPayload).split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...validPayload, maxSeats: 5000 }),
      'utf8',
    ).toString('base64url');

    expect(
      verifyLicenseKey(
        `${prefix}.${tamperedPayload}.${signature}`,
        publicKeySpkiB64,
      ),
    ).toBeNull();
  });

  it('rejects a key signed by a different keypair', () => {
    const otherKeypair = generateKeyPairSync('ed25519');
    const payloadBytes = Buffer.from(JSON.stringify(validPayload), 'utf8');
    const signature = sign(null, payloadBytes, otherKeypair.privateKey);
    const forgedKey = `RMLK1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;

    expect(verifyLicenseKey(forgedKey, publicKeySpkiB64)).toBeNull();
  });

  it('rejects malformed keys', () => {
    expect(verifyLicenseKey('', publicKeySpkiB64)).toBeNull();
    expect(verifyLicenseKey('not-a-key', publicKeySpkiB64)).toBeNull();
    expect(verifyLicenseKey('RMLK1.onlyonepart', publicKeySpkiB64)).toBeNull();
    expect(
      verifyLicenseKey('WRONG.payload.signature', publicKeySpkiB64),
    ).toBeNull();
    expect(
      verifyLicenseKey(`${issueKey(validPayload)}.extra`, publicKeySpkiB64),
    ).toBeNull();
  });

  it.each([
    ['missing licensee', { ...validPayload, licensee: '' }],
    ['non-integer seats', { ...validPayload, maxSeats: 10.5 }],
    ['zero seats', { ...validPayload, maxSeats: 0 }],
    ['missing issuedAt', { ...validPayload, issuedAt: undefined }],
    ['unparseable expiresAt', { ...validPayload, expiresAt: 'not-a-date' }],
  ])('rejects a signed payload with %s', (_label, payload) => {
    expect(verifyLicenseKey(issueKey(payload), publicKeySpkiB64)).toBeNull();
  });

  it('rejects keys signed for a different deployment public key', () => {
    // The default public key parameter is the production key, which this
    // test keypair is not.
    expect(verifyLicenseKey(issueKey(validPayload))).toBeNull();
  });
});

describe('resolveLicenseState', () => {
  it('returns the free limit when no key is stored', () => {
    expect(resolveLicenseState(null)).toEqual({
      status: 'unlicensed',
      seatLimit: FREE_SEAT_LIMIT,
    });
    expect(resolveLicenseState('   ')).toEqual({
      status: 'unlicensed',
      seatLimit: FREE_SEAT_LIMIT,
    });
  });

  it('falls back to the free limit for unverifiable keys', () => {
    // Signed by the test keypair, not the production key resolveLicenseState
    // verifies against by default.
    expect(resolveLicenseState(issueKey(validPayload))).toEqual({
      status: 'invalid',
      seatLimit: FREE_SEAT_LIMIT,
    });
  });

  it('uses the licensed seat count for a valid key', () => {
    const state = resolveLicenseState(
      issueKey(validPayload),
      new Date('2026-06-01T00:00:00.000Z'),
      publicKeySpkiB64,
    );

    expect(state).toMatchObject({
      status: 'valid',
      seatLimit: 50,
      licensee: 'Acme Corp',
    });
  });

  it('never lowers the limit below the free tier', () => {
    const state = resolveLicenseState(
      issueKey({ ...validPayload, maxSeats: 1 }),
      new Date('2026-06-01T00:00:00.000Z'),
      publicKeySpkiB64,
    );

    expect(state).toMatchObject({
      status: 'valid',
      seatLimit: FREE_SEAT_LIMIT,
    });
  });

  it('falls back to the free limit once a key expires', () => {
    const key = issueKey({
      ...validPayload,
      expiresAt: '2026-05-01T00:00:00.000Z',
    });

    expect(
      resolveLicenseState(
        key,
        new Date('2026-04-01T00:00:00.000Z'),
        publicKeySpkiB64,
      ),
    ).toMatchObject({ status: 'valid', seatLimit: 50 });
    expect(
      resolveLicenseState(
        key,
        new Date('2026-06-01T00:00:00.000Z'),
        publicKeySpkiB64,
      ),
    ).toMatchObject({ status: 'expired', seatLimit: FREE_SEAT_LIMIT });
  });
});
