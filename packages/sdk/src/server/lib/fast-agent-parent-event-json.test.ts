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
});
