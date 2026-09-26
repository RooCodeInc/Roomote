import { describe, expect, it } from 'vitest';

import { isStopSessionCommandText } from '../session-command';

describe('isStopSessionCommandText', () => {
  it.each(['/stop', 'stop', '/stop tasks', 'stop task'])(
    'recognizes the standalone command %s',
    (text) => {
      expect(isStopSessionCommandText(text)).toBe(true);
    },
  );

  it('allows a leading Slack or Teams bot mention', () => {
    expect(isStopSessionCommandText('<@U123> /stop')).toBe(true);
    expect(isStopSessionCommandText('<at>Roomote</at> stop tasks')).toBe(true);
  });

  it.each([
    'please stop the build',
    '/stop when you finish',
    'stop by the office',
    '<at>Roomote</at> please stop this task',
  ])('does not classify ordinary text as a command: %s', (text) => {
    expect(isStopSessionCommandText(text)).toBe(false);
  });
});
