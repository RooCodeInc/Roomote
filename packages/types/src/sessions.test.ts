import { describe, expect, it } from 'vitest';

import { getSessionBoardColumn, SESSION_MANUAL_STATUSES } from './sessions';

describe('SESSION_MANUAL_STATUSES', () => {
  it('keeps manual statuses in product order without exposing active', () => {
    expect(SESSION_MANUAL_STATUSES).toEqual([
      'needs_input',
      'blocked',
      'ready',
      'done',
    ]);
  });
});

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

  it('keeps a manually selected status ahead of semantic judgment', () => {
    expect(
      getSessionBoardColumn({
        cachedStatus: 'ready',
        manualStatus: 'ready',
        judgmentStatus: 'done',
      }),
    ).toBe('ready');

    expect(
      getSessionBoardColumn({
        cachedStatus: 'active',
        manualStatus: 'done',
        judgmentStatus: 'open',
      }),
    ).toBe('done');
  });
});
