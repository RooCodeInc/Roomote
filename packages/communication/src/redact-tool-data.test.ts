import { describe, it, expect } from 'vitest';
import { redactToolData } from './redact-secrets';

describe('tool diagnostic redaction', () => {
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
});
