import { sanitizeFastAgentParentEventJson } from './fast-agent-parent-event-json';

describe('sanitizeFastAgentParentEventJson', () => {
  it('removes NUL characters recursively from nested JSON values and keys', () => {
    const payload = {
      context: 'before\0after',
      nested: {
        ['key\0with-nul']: ['left\0right', { value: '\0only' }],
      },
    };

    expect(sanitizeFastAgentParentEventJson(payload)).toEqual({
      context: 'beforeafter',
      nested: {
        'keywith-nul': ['leftright', { value: 'only' }],
      },
    });
  });

  it('leaves ordinary payloads unchanged', () => {
    const payload = {
      event: 'pull_request_opened',
      pullRequest: { number: 42, title: 'Keep delivery ordered' },
    };

    expect(sanitizeFastAgentParentEventJson(payload)).toBe(payload);
  });

  it('rebuilds only the branches affected by sanitization', () => {
    const untouched = { value: 'keep this reference' };
    const payload = {
      untouched,
      nested: { value: 'remove\0this character' },
    };

    const sanitized = sanitizeFastAgentParentEventJson(
      payload,
    ) as typeof payload;

    expect(sanitized).not.toBe(payload);
    expect(sanitized.untouched).toBe(untouched);
    expect(sanitized.nested).not.toBe(payload.nested);
  });

  it('rejects sanitized key collisions instead of dropping a property', () => {
    const payload = {
      ['same\0key']: 'earlier value',
      samekey: 'later value',
    };

    expect(() => sanitizeFastAgentParentEventJson(payload)).toThrow(
      'Fast parent event JSON keys collide after NUL sanitization.',
    );
  });
});
