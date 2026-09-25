import { describe, expect, it } from 'vitest';

import { getSessionBoardColumn } from './sessions';

describe('getSessionBoardColumn', () => {
  it('keeps live runtime and structured-input states authoritative', () => {
    expect(
      getSessionBoardColumn({
        cachedStatus: 'active',
        judgmentStatus: 'done',
      }),
    ).toBe('active');
    expect(
      getSessionBoardColumn({
        cachedStatus: 'needs_input',
        judgmentStatus: 'done',
      }),
    ).toBe('needs_input');
    expect(
      getSessionBoardColumn({
        cachedStatus: 'blocked',
        judgmentStatus: 'done',
      }),
    ).toBe('blocked');
  });

  it('projects semantic outcomes only from a settled runtime status', () => {
    expect(
      getSessionBoardColumn({ cachedStatus: 'ready', judgmentStatus: 'done' }),
    ).toBe('done');
    expect(
      getSessionBoardColumn({
        cachedStatus: 'ready',
        judgmentStatus: 'needs_input',
      }),
    ).toBe('needs_input');
    expect(
      getSessionBoardColumn({ cachedStatus: null, judgmentStatus: 'blocked' }),
    ).toBe('blocked');
    expect(
      getSessionBoardColumn({
        cachedStatus: 'ready',
        judgmentStatus: 'unclear',
      }),
    ).toBe('ready');
  });
});
