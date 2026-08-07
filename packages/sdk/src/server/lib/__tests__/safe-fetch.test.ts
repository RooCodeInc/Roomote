import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SafeFetchViolationError,
  checkAddressAllowed,
  parseCidrList,
  safeFetch,
  validateEgressUrl,
  type DnsLookupFn,
} from '../safe-fetch';

describe('checkAddressAllowed', () => {
  const noAllowances = parseCidrList(undefined);

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.251',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
  ])('blocks %s', (ip) => {
    expect(checkAddressAllowed(ip, noAllowances)).not.toBeNull();
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public %s',
    (ip) => {
      expect(checkAddressAllowed(ip, noAllowances)).toBeNull();
    },
  );

  it('blocks IPv4-mapped IPv6 forms of private addresses', () => {
    expect(checkAddressAllowed('::ffff:10.0.0.1', noAllowances)).not.toBeNull();
    expect(
      checkAddressAllowed('::ffff:169.254.169.254', noAllowances),
    ).not.toBeNull();
  });

  it('allows IPv4-mapped IPv6 forms of public addresses', () => {
    expect(checkAddressAllowed('::ffff:1.1.1.1', noAllowances)).toBeNull();
  });

  it('blocks NAT64-embedded private addresses', () => {
    expect(
      checkAddressAllowed('64:ff9b::10.0.0.1', noAllowances),
    ).not.toBeNull();
  });

  it('honors explicit CIDR allowances without opening adjacent ranges', () => {
    const allowed = parseCidrList('10.1.0.0/16');

    expect(checkAddressAllowed('10.1.2.3', allowed)).toBeNull();
    expect(checkAddressAllowed('10.2.0.1', allowed)).not.toBeNull();
    expect(checkAddressAllowed('192.168.1.1', allowed)).not.toBeNull();
  });

  it('an allowance for one range does not affect IPv6 blocking', () => {
    const allowed = parseCidrList('10.0.0.0/8');

    expect(checkAddressAllowed('fd00::1', allowed)).not.toBeNull();
  });
});

describe('parseCidrList', () => {
  it('parses comma-separated mixed-family lists', () => {
    const parsed = parseCidrList('10.0.0.0/8, fd00::/8,192.168.1.10');

    expect(parsed).toHaveLength(3);
    expect(parsed[2]!.prefix).toBe(32);
  });

  it('rejects malformed entries loudly', () => {
    expect(() => parseCidrList('not-a-cidr')).toThrow(SafeFetchViolationError);
    expect(() => parseCidrList('10.0.0.0/33')).toThrow(SafeFetchViolationError);
  });
});

describe('validateEgressUrl', () => {
  it('rejects non-http schemes and userinfo', () => {
    expect(() => validateEgressUrl('ftp://example.com')).toThrow(
      SafeFetchViolationError,
    );
    expect(() => validateEgressUrl('https://user:pass@example.com')).toThrow(
      SafeFetchViolationError,
    );
    expect(() => validateEgressUrl('not a url')).toThrow(
      SafeFetchViolationError,
    );
  });

  it('accepts plain http URLs', () => {
    expect(validateEgressUrl('http://example.com/mcp').hostname).toBe(
      'example.com',
    );
  });
});

describe('safeFetch', () => {
  let server: Server;
  let port: number;

  const lookupTo127: DnsLookupFn = ((hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;

    const result = [{ address: '127.0.0.1', family: 4 }];

    if ((opts as { all?: boolean }).all) {
      (cb as (err: null, addresses: unknown) => void)(null, result);
    } else {
      (cb as (err: null, address: string, family: number) => void)(
        null,
        '127.0.0.1',
        4,
      );
    }
  }) as DnsLookupFn;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1/internal');
        res.end();
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('refuses hostnames that resolve to blocked addresses', async () => {
    await expect(
      safeFetch(`http://blocked.example:${port}/`, { lookup: lookupTo127 }),
    ).rejects.toThrow(SafeFetchViolationError);
  });

  it('connects to the vetted address when a CIDR allowance covers it', async () => {
    const response = await safeFetch(`http://pinned.example:${port}/`, {
      lookup: lookupTo127,
      allowedPrivateCidrs: '127.0.0.0/8',
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; host: string };

    expect(body.ok).toBe(true);
    // The Host header carries the original hostname even though the socket
    // was pinned to the vetted address.
    expect(body.host).toBe(`pinned.example:${port}`);
  });

  it('refuses IP-literal URLs in blocked ranges without DNS involvement', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { lookup: lookupTo127 }),
    ).rejects.toThrow(SafeFetchViolationError);
  });

  it('refuses redirects instead of following them', async () => {
    await expect(
      safeFetch(`http://redirect.example:${port}/redirect`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
      }),
    ).rejects.toThrow(/redirect/);
  });
});
