import { describe, expect, it } from 'vitest';

import { parseGoalCommand } from '../goal-command';

describe('parseGoalCommand', () => {
  it('parses the canonical command case-insensitively', () => {
    expect(parseGoalCommand('/GOAL   ship the release  ')).toEqual({
      objective: 'ship the release',
      goal: { objective: 'ship the release', maxContinuations: 5 },
    });
  });

  it('returns an empty command result so providers can show usage', () => {
    expect(parseGoalCommand('/goal')).toEqual({ objective: '', goal: null });
  });

  it('does not intercept ordinary messages', () => {
    expect(parseGoalCommand('please /goal ship the release')).toBeNull();
    expect(parseGoalCommand('/goalkeeper notes')).toBeNull();
  });
});
