import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  ApnsRetryableError,
  buildApnsProviderToken,
  buildApnsRequest,
  getApnsProviderToken,
  resetApnsProviderTokenCache,
  sendApnsPush,
  type ApnsRequest,
  type ApnsResponse,
} from './apns';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const credentials = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  bundleId: 'dev.roomote.app',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function fakeTransport(responses: ApnsResponse[]) {
  const calls: ApnsRequest[] = [];
  const transport = vi.fn(async (request: ApnsRequest) => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error('No scripted APNs response left');
    return next;
  });
  return { transport, calls };
}

describe('APNs provider token', () => {
  beforeEach(() => resetApnsProviderTokenCache());

  it('signs an ES256 JWT Apple can verify', () => {
    const token = buildApnsProviderToken(credentials, 1_700_000_000);
    const [header, claims, signature] = token.split('.') as [
      string,
      string,
      string,
    ];

    expect(decodeSegment(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decodeSegment(claims)).toEqual({
      iss: 'TEAM123456',
      iat: 1_700_000_000,
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('caches the token for fifty minutes per key', () => {
    const first = getApnsProviderToken(credentials, 1_000_000);
    expect(getApnsProviderToken(credentials, 1_000_000 + 49 * 60_000)).toBe(
      first,
    );
    expect(getApnsProviderToken(credentials, 1_000_000 + 51 * 60_000)).not.toBe(
      first,
    );
  });
});

describe('buildApnsRequest', () => {
  it('targets the environment host with the documented headers', () => {
    const request = buildApnsRequest({
      deviceToken: 'abc123',
      environment: 'sandbox',
      bundleId: 'dev.roomote.app',
      providerToken: 'jwt',
      payload: { aps: { alert: { title: 'Hi', body: 'There' } } },
      collapseId: 'reply:session-1',
    });

    expect(request).toEqual({
      host: 'https://api.sandbox.push.apple.com',
      path: '/3/device/abc123',
      headers: {
        authorization: 'bearer jwt',
        'apns-topic': 'dev.roomote.app',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': 'reply:session-1',
        'content-type': 'application/json',
      },
      body: '{"aps":{"alert":{"title":"Hi","body":"There"}}}',
    });
    expect(
      buildApnsRequest({
        deviceToken: 'abc123',
        environment: 'production',
        bundleId: 'dev.roomote.app',
        providerToken: 'jwt',
        payload: {},
      }),
    ).toMatchObject({ host: 'https://api.push.apple.com' });
  });
});

describe('sendApnsPush', () => {
  beforeEach(() => resetApnsProviderTokenCache());

  const send = (responses: ApnsResponse[]) => {
    const fake = fakeTransport(responses);
    return {
      ...fake,
      result: sendApnsPush(
        {
          credentials,
          deviceToken: 'device-token',
          environment: 'production',
          payload: { aps: { alert: { title: 'T', body: 'B' } } },
        },
        fake.transport,
      ),
    };
  };

  it('reports success on 200', async () => {
    const { result, calls } = send([{ status: 200, body: '' }]);
    await expect(result).resolves.toEqual({ outcome: 'sent' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toMatch(/^bearer ey/);
  });

  it('flags a gone token on 410 and on BadDeviceToken', async () => {
    await expect(
      send([{ status: 410, body: '{"reason":"Unregistered"}' }]).result,
    ).resolves.toEqual({ outcome: 'unregistered', reason: 'Unregistered' });
    await expect(
      send([{ status: 400, body: '{"reason":"BadDeviceToken"}' }]).result,
    ).resolves.toEqual({ outcome: 'unregistered', reason: 'BadDeviceToken' });
  });

  it('refreshes the provider token once when Apple rejects it', async () => {
    const stale = getApnsProviderToken(credentials, Date.now());
    const { result, calls } = send([
      { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      { status: 200, body: '' },
    ]);
    await expect(result).resolves.toEqual({ outcome: 'sent' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.authorization).toBe(`bearer ${stale}`);
    expect(calls[1]!.headers.authorization).not.toBe(`bearer ${stale}`);
  });

  it('throws so the queue retries on 429 and 5xx', async () => {
    await expect(
      send([{ status: 429, body: '{"reason":"TooManyRequests"}' }]).result,
    ).rejects.toBeInstanceOf(ApnsRetryableError);
    await expect(
      send([{ status: 503, body: '' }]).result,
    ).rejects.toBeInstanceOf(ApnsRetryableError);
  });

  it('returns other rejections without retrying', async () => {
    await expect(
      send([{ status: 400, body: '{"reason":"PayloadTooLarge"}' }]).result,
    ).resolves.toEqual({
      outcome: 'rejected',
      status: 400,
      reason: 'PayloadTooLarge',
    });
  });
});
