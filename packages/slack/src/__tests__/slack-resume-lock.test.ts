import { getSlackResumeLockKey } from '../slack-resume-lock';

describe('getSlackResumeLockKey', () => {
  it('serializes resume producers per task without blocking sibling tasks', () => {
    expect(getSlackResumeLockKey('111.222', 'task-a')).toBe(
      getSlackResumeLockKey('111.222', 'task-a'),
    );
    expect(getSlackResumeLockKey('111.222', 'task-a')).not.toBe(
      getSlackResumeLockKey('111.222', 'task-b'),
    );
  });
});
