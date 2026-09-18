import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SafeFetchViolationError,
  checkAddressAllowed,
  fetchPublicUrl,
  fetchPublicUrlForTesting,
  parseCidrList,
  safeFetch,
  safeHeadFollowingRedirects,
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
    '::7f00:1',
    'fe80::1',
    'fd00::1',
    'fec0::1',
    'ff02::1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    '4000::1',
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
  let cloudflareAttempts = 0;

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

      if (req.url === '/safe-redirect') {
        res.statusCode = 302;
        res.setHeader('location', `http://redirected.example:${port}/final`);
        res.end();
        return;
      }

      if (req.url === '/blocked-redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.2/internal');
        res.end();
        return;
      }

      if (req.url === '/text-redirect') {
        res.statusCode = 302;
        res.setHeader('location', `http://redirected.example:${port}/text`);
        res.end();
        return;
      }

      if (req.url === '/text') {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('public text');
        return;
      }

      if (req.url === '/html') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<h1>Hello</h1><p>Useful <strong>content</strong>.</p><script>ignore()</script>',
        );
        return;
      }

      if (req.url === '/image') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }

      if (req.url === '/compressed-large') {
        const compressed = gzipSync('x'.repeat(2_000));
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', String(compressed.byteLength));
        res.end(compressed);
        return;
      }

      if (req.url === '/binary') {
        res.setHeader('content-type', 'application/octet-stream');
        res.end('bytes');
        return;
      }

      if (req.url === '/missing-content-type') {
        res.end('untyped');
        return;
      }

      if (req.url === '/latin1') {
        res.setHeader('content-type', 'text/plain; charset=iso-8859-1');
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        return;
      }

      if (req.url === '/meta-latin1') {
        res.setHeader('content-type', 'text/html');
        res.end(
          Buffer.concat([
            Buffer.from('<meta charset="windows-1252"><p>caf'),
            Buffer.from([0xe9]),
            Buffer.from('</p>'),
          ]),
        );
        return;
      }

      if (req.url === '/large-html') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<p>${'x'.repeat(1_024 * 1_024)}</p>`);
        return;
      }

      if (req.url === '/unsupported-charset') {
        res.setHeader('content-type', 'text/plain; charset=made-up-encoding');
        res.end('text');
        return;
      }

      if (req.url === '/invalid-utf8') {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(Buffer.from([0xc3, 0x28]));
        return;
      }

      if (req.url === '/same-origin-redirect') {
        res.statusCode = 302;
        res.setHeader('location', '/headers');
        res.end();
        return;
      }

      if (req.url === '/cross-origin-redirect') {
        res.statusCode = 302;
        res.setHeader('location', `http://redirected.example:${port}/headers`);
        res.end();
        return;
      }

      if (req.url === '/headers') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(req.headers));
        return;
      }

      if (req.url === '/cloudflare') {
        cloudflareAttempts += 1;
        if (req.headers['user-agent'] !== 'Roomote-Public-URL-Fetch/1.0') {
          res.statusCode = 403;
          res.setHeader('cf-mitigated', 'challenge');
          res.end();
          return;
        }
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('retry succeeded');
        return;
      }

      if (req.url === '/slow') {
        setTimeout(() => {
          res.setHeader('content-type', 'text/plain');
          res.end('late');
        }, 100);
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-host', req.headers.host ?? '');
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

  it('refuses a hostname when any DNS answer is non-public', async () => {
    const mixedLookup = ((hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const addresses = [
        { address: '127.0.0.1', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ];
      (cb as (error: null, result: unknown) => void)(null, addresses);
    }) as DnsLookupFn;

    await expect(
      safeFetch('http://mixed.example/', { lookup: mixedLookup }),
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

  it('revalidates and follows a bounded redirect chain when requested', async () => {
    const response = await safeHeadFollowingRedirects(
      `http://redirect.example:${port}/safe-redirect`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        maxRedirects: 1,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-host')).toBe(
      `redirected.example:${port}`,
    );
  });

  it('rejects non-HTTPS initial and redirect URLs when HTTPS is required', async () => {
    await expect(
      safeHeadFollowingRedirects(`http://redirect.example:${port}/`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        requireHttps: true,
      }),
    ).rejects.toThrow(/must use https/);
  });

  it('reapplies address guards to redirect targets', async () => {
    await expect(
      safeHeadFollowingRedirects(
        `http://redirect.example:${port}/blocked-redirect`,
        {
          lookup: lookupTo127,
          allowedPrivateCidrs: '127.0.0.1/32',
        },
      ),
    ).rejects.toThrow(SafeFetchViolationError);
  });

  it('fetches bounded text through pinned addresses and validated redirects', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/text-redirect`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      },
    );

    expect(result).toEqual({
      kind: 'text',
      url: `http://redirected.example:${port}/text`,
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      format: 'markdown',
      text: 'public text',
    });
  });

  it.each([
    ['markdown', '# Hello\n\nUseful **content**.'],
    ['text', 'HelloUseful content.'],
    [
      'html',
      '<h1>Hello</h1><p>Useful <strong>content</strong>.</p><script>ignore()</script>',
    ],
  ] as const)('returns HTML as %s', async (format, expected) => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/html`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        format,
      },
    );

    expect(result).toMatchObject({ kind: 'text', format, text: expected });
  });

  it('returns supported images as bounded base64 content', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/image`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      },
    );

    expect(result).toEqual({
      kind: 'image',
      url: `http://public.example:${port}/image`,
      status: 200,
      contentType: 'image/png',
      mimeType: 'image/png',
      data: 'iVBORw==',
      size: 4,
    });
  });

  it('rejects non-default ports outside controlled fixtures', async () => {
    await expect(fetchPublicUrl('https://example.com:8443/')).rejects.toThrow(
      /default HTTP and HTTPS ports/,
    );
  });

  it('enforces the decompressed response size', async () => {
    await expect(
      fetchPublicUrlForTesting(
        `http://public.example:${port}/compressed-large`,
        {
          lookup: lookupTo127,
          allowedPrivateCidrs: '127.0.0.0/8',
          allowNonDefaultPorts: true,
          maxResponseBytes: 1_000,
        },
      ),
    ).rejects.toThrow(/too large/);
  });

  it('rejects non-text content types', async () => {
    await expect(
      fetchPublicUrlForTesting(`http://public.example:${port}/binary`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      }),
    ).rejects.toThrow(/text content type/);
  });

  it('fails closed when a response omits its content type', async () => {
    await expect(
      fetchPublicUrlForTesting(
        `http://public.example:${port}/missing-content-type`,
        {
          lookup: lookupTo127,
          allowedPrivateCidrs: '127.0.0.0/8',
          allowNonDefaultPorts: true,
        },
      ),
    ).rejects.toThrow(/text content type/);
  });

  it('decodes a supported declared charset without replacement', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/latin1`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      },
    );
    expect(result).toMatchObject({ kind: 'text', text: 'café' });
  });

  it('uses an HTML meta charset when the response header omits one', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/meta-latin1`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        format: 'text',
      },
    );
    expect(result).toMatchObject({ kind: 'text', text: 'café' });
  });

  it('rejects unsupported declared charsets', async () => {
    await expect(
      fetchPublicUrlForTesting(
        `http://public.example:${port}/unsupported-charset`,
        {
          lookup: lookupTo127,
          allowedPrivateCidrs: '127.0.0.0/8',
          allowNonDefaultPorts: true,
        },
      ),
    ).rejects.toThrow(/unsupported charset/);
  });

  it('rejects malformed UTF-8 payloads', async () => {
    await expect(
      fetchPublicUrlForTesting(`http://public.example:${port}/invalid-utf8`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      }),
    ).rejects.toThrow(/not valid utf-8 text/i);
  });

  it('bounds control-plane HTML-to-markdown conversion work', async () => {
    await expect(
      fetchPublicUrlForTesting(`http://public.example:${port}/large-html`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        format: 'markdown',
      }),
    ).rejects.toThrow(/too large to convert to markdown/);

    const raw = await fetchPublicUrlForTesting(
      `http://public.example:${port}/large-html`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        format: 'html',
      },
    );
    expect(raw).toMatchObject({ kind: 'text', format: 'html' });
  });

  it('sends explicit caller headers on same-origin redirects', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/same-origin-redirect`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        format: 'text',
        headers: {
          Authorization: 'Bearer explicit',
          Cookie: 'session=explicit',
          'X-Trace': 'same-origin',
        },
      },
    );
    expect(result.kind).toBe('text');
    const headers = JSON.parse(
      result.kind === 'text' ? result.text : '{}',
    ) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer explicit');
    expect(headers.cookie).toBe('session=explicit');
    expect(headers['x-trace']).toBe('same-origin');
    expect(headers.accept).toContain('text/plain');
  });

  it('strips sensitive caller headers on cross-origin redirects', async () => {
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/cross-origin-redirect`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        headers: {
          Authorization: 'Bearer explicit',
          Cookie: 'session=explicit',
          'X-Api-Key': 'explicit-key',
          'X-Auth-Token': 'explicit-token',
          'X-Trace': 'cross-origin',
        },
      },
    );
    expect(result.kind).toBe('text');
    const headers = JSON.parse(
      result.kind === 'text' ? result.text : '{}',
    ) as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('x-api-key');
    expect(headers).not.toHaveProperty('x-auth-token');
    expect(headers['x-trace']).toBe('cross-origin');
  });

  it('rejects caller control of transport headers', async () => {
    await expect(
      fetchPublicUrl('https://example.com/', {
        headers: { Host: 'internal.example' },
      }),
    ).rejects.toThrow(/does not allow the 'host' header/);
  });

  it('retries Cloudflare challenges with an honest user agent', async () => {
    cloudflareAttempts = 0;
    const result = await fetchPublicUrlForTesting(
      `http://public.example:${port}/cloudflare`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
      },
    );
    expect(result).toMatchObject({ kind: 'text', text: 'retry succeeded' });
    expect(cloudflareAttempts).toBe(2);
  });

  it('bounds total request duration', async () => {
    await expect(
      fetchPublicUrlForTesting(`http://public.example:${port}/slow`, {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
  });

  it('rejects caller timeouts above the 120-second ceiling', async () => {
    await expect(
      fetchPublicUrl('https://example.com/', { timeout: 121 }),
    ).rejects.toThrow(/at most 120 seconds/);
  });

  it('honors caller cancellation while reading the response', async () => {
    const controller = new AbortController();
    const pending = fetchPublicUrlForTesting(
      `http://public.example:${port}/slow`,
      {
        lookup: lookupTo127,
        allowedPrivateCidrs: '127.0.0.0/8',
        allowNonDefaultPorts: true,
        signal: controller.signal,
        timeoutMs: 1_000,
      },
    );
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});
