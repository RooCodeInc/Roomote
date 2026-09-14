import { describe, expect, it } from 'vitest';

import { unwrapStringifiedIntegrationArgs } from '../fast-agent-integration-args';

describe('unwrapStringifiedIntegrationArgs', () => {
  it('leaves arguments without an args wrapper untouched', () => {
    const args = { channel: 'C1', oldest: '2026-09-01' };
    expect(unwrapStringifiedIntegrationArgs(args, undefined)).toBe(args);
  });

  it('unwraps a JSON string args wrapper into top-level arguments', () => {
    expect(
      unwrapStringifiedIntegrationArgs(
        {
          args: '{"oldest": "2026-09-07T00:00:00Z", "latest": "2026-09-07T23:59:59Z"}',
          channel: 'C1',
        },
        undefined,
      ),
    ).toEqual({
      channel: 'C1',
      oldest: '2026-09-07T00:00:00Z',
      latest: '2026-09-07T23:59:59Z',
    });
  });

  it('unwraps an object args wrapper', () => {
    expect(
      unwrapStringifiedIntegrationArgs(
        { args: { oldest: '2026-09-01' }, channel: 'C1' },
        undefined,
      ),
    ).toEqual({ channel: 'C1', oldest: '2026-09-01' });
  });

  it('lets explicit top-level keys win over wrapped ones', () => {
    expect(
      unwrapStringifiedIntegrationArgs(
        { args: '{"channel": "C2", "oldest": "2026-09-01"}', channel: 'C1' },
        undefined,
      ),
    ).toEqual({ channel: 'C1', oldest: '2026-09-01' });
  });

  it('drops an empty wrapper', () => {
    expect(
      unwrapStringifiedIntegrationArgs({ args: '{}', channel: 'C1' }, undefined),
    ).toEqual({ channel: 'C1' });
    expect(
      unwrapStringifiedIntegrationArgs({ args: '   ', channel: 'C1' }, undefined),
    ).toEqual({ channel: 'C1' });
  });

  it('keeps args when the tool schema declares an args property', () => {
    const args = { args: '["--version"]', command: 'node' };
    expect(
      unwrapStringifiedIntegrationArgs(args, {
        type: 'object',
        properties: { command: { type: 'string' }, args: { type: 'array' } },
      }),
    ).toBe(args);
  });

  it('keeps args that are not a JSON object', () => {
    const malformed = { args: '{not json', channel: 'C1' };
    expect(unwrapStringifiedIntegrationArgs(malformed, undefined)).toBe(
      malformed,
    );
    const list = { args: ['a', 'b'], channel: 'C1' };
    expect(unwrapStringifiedIntegrationArgs(list, undefined)).toBe(list);
    const scalar = { args: '"text"', channel: 'C1' };
    expect(unwrapStringifiedIntegrationArgs(scalar, undefined)).toBe(scalar);
  });
});
