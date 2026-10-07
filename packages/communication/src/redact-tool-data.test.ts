import { describe, it, expect } from 'vitest';
import { redactToolData } from './redact-secrets';

describe('tool diagnostic redaction', () => {
  it('masks the complete unquoted multiword credential value through EOL', () => {
    const parts = [
      'fixture-segment-a',
      'fixture-segment-b',
      'fixture-segment-c',
    ];
    const output = redactToolData({
      output: `password: ${parts.join(' ')}\nstatus: online`,
      tokenCount: 42,
    });
    expect(parts.some((part) => output.output.includes(part))).toBe(false);
    expect(output.output.includes('status: online')).toBe(true);
    expect(output.tokenCount).toBe(42);
  });
  const credentialCases = [
    { name: 'GitLab', make: () => ({ value: `glpat-${'G1h2'.repeat(6)}` }) },
    {
      name: 'Stripe',
      make: () => ({ value: `sk_${'live'}_${'S3t4'.repeat(6)}` }),
    },
    { name: 'AWS', make: () => ({ value: `AKIA${'A1B2'.repeat(4)}` }) },
    { name: 'Google', make: () => ({ value: `AIza${'C1d2E'.repeat(7)}` }) },
    {
      name: 'percent-encoded GitHub',
      make: () => ({
        value: [...`ghp_${'F5g6'.repeat(9)}`]
          .map((char) => `%${char.charCodeAt(0).toString(16)}`)
          .join(''),
      }),
    },
    {
      name: 'truncated private-key block',
      make: () => ({
        value: `-----BEGIN RSA PRIVATE KEY-----\n${'synthetic-private-material'.repeat(3)}`,
        probe: 'synthetic-private-material',
      }),
    },
  ];
  it.each(credentialCases)(
    'masks the shared credential inventory: $name',
    ({ make }) => {
      const fixture: { value: string; probe?: string } = make();
      const output = redactToolData({
        output: `diagnostic before ${fixture.value} after`,
        tokenCount: 42,
      });
      expect(output.output.includes(fixture.probe ?? fixture.value)).toBe(
        false,
      );
      expect(output.tokenCount).toBe(42);
      expect(output.output.includes('diagnostic before')).toBe(true);
    },
  );
  const sentinel = 'synthetic diagnostic value';
  it.each([
    ['quoted JSON', JSON.stringify({ password: sentinel, pid: 123 })],
    [
      'escaped JSON',
      JSON.stringify({
        headers: { Authorization: `${sentinel}\nsecond line` },
      }),
    ],
    ['text assignment', `SERVICE_PASSWORD="${sentinel}"`],
    ['line-numbered header', `12: "Authorization": "${sentinel}"`],
    ['environment array', { env: { CUSTOM_SETTING: [sentinel, 123] } }],
    [
      'PM2 environment',
      { pm2_env: { CUSTOM_SETTING: sentinel, status: 'online' } },
    ],
  ])('removes values from %s', (_label, input) => {
    expect(JSON.stringify(redactToolData(input)).includes(sentinel)).toBe(
      false,
    );
  });
  it('removes known credential values from otherwise unlabeled output', () => {
    expect(
      redactToolData(`diagnostic: ${sentinel}`, [sentinel]).includes(sentinel),
    ).toBe(false);
  });
  it('redacts arbitrary environment assignments including quoted multiline values', () => {
    const text = `CUSTOM_SETTING=${sentinel}\nexport lower_case='${sentinel}\ncontinued fixture'\nstatus: online`;
    const output = redactToolData(text);
    expect(output.includes(sentinel)).toBe(false);
    expect(output.includes('continued fixture')).toBe(false);
    expect(output.includes('CUSTOM_SETTING=')).toBe(true);
    expect(output.includes('status: online')).toBe(true);
  });
  it.each(['    12\t', '12: ', '  12 | '])(
    'redacts assignment values with a diagnostic line prefix',
    (prefix) => {
      const output = redactToolData(
        `${prefix}CUSTOM_SETTING=${sentinel}\n${prefix}export lower_case="${sentinel}\ncontinued fixture"\nstatus: online`,
      );
      expect(output.includes(sentinel)).toBe(false);
      expect(output.includes('continued fixture')).toBe(false);
      expect(output.includes(prefix)).toBe(true);
      expect(output.includes('CUSTOM_SETTING=')).toBe(true);
      expect(output.includes('status: online')).toBe(true);
    },
  );
  it('masks arbitrary PM2 environment entries while retaining approved process metadata', () => {
    const input = {
      pid: 123,
      name: 'api',
      pm2_env: {
        custom_setting: sentinel,
        MixedSetting: sentinel,
        custom_object: { value: sentinel },
        status: 'online',
        restart_time: 3,
      },
    };
    const output = redactToolData(input);
    expect(JSON.stringify(output).includes(sentinel)).toBe(false);
    expect(output.pid).toBe(123);
    expect(output.pm2_env.status).toBe('online');
    expect(output.pm2_env.restart_time).toBe(3);
  });

  it('preserves safe metadata and does not mutate its input', () => {
    const input = {
      name: 'api',
      pid: 123,
      tokenCount: 42,
      headers: { 'X-Request-Id': 'req-1' },
      env: { CUSTOM_SETTING: sentinel },
    };
    const output = redactToolData(input);
    expect(output.name).toBe('api');
    expect(output.pid).toBe(123);
    expect(output.tokenCount).toBe(42);
    expect(output.headers['X-Request-Id']).toBe('req-1');
    expect(input.env.CUSTOM_SETTING === sentinel).toBe(true);
  });
  it('does not apply integration preview bounds or shorten unrecognized tool content', () => {
    const text = 'n'.repeat(20_000);
    const input = {
      tokenCount: 42,
      output: text,
      items: Array.from({ length: 80 }, (_, id) => ({ id })),
    };
    const output = redactToolData(input);
    expect(output.output === text).toBe(true);
    expect(output.items.length).toBe(80);
    expect(output.tokenCount).toBe(42);
  });
});
