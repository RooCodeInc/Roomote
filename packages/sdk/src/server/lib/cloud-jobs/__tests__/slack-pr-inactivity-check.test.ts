import type { PullRequestActivitySnapshot } from '../slack-pr-inactivity-check';
import {
  hasPullRequestMoved,
  isPullRequestTerminal,
} from '../slack-pr-inactivity-check';

const BASELINE: PullRequestActivitySnapshot = {
  headSha: 'abc123',
  state: 'open',
  draft: false,
  merged: false,
  updatedAt: '2026-03-10T12:00:00.000Z',
  combinedStatus: 'pending',
};

describe('hasPullRequestMoved', () => {
  it('returns false when the PR snapshot is unchanged', () => {
    expect(
      hasPullRequestMoved({ baseline: BASELINE, current: { ...BASELINE } }),
    ).toBe(false);
  });

  it('returns true when the head SHA changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, headSha: 'def456' },
      }),
    ).toBe(true);
  });

  it('returns true when lifecycle state changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, state: 'closed' },
      }),
    ).toBe(true);
  });

  it('returns true when draft flag changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, draft: true },
      }),
    ).toBe(true);
  });

  it('returns true when merged flag changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, merged: true },
      }),
    ).toBe(true);
  });

  it('returns true when updated timestamp changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, updatedAt: '2026-03-11T12:00:00.000Z' },
      }),
    ).toBe(true);
  });

  it('returns true when combined status changes', () => {
    expect(
      hasPullRequestMoved({
        baseline: BASELINE,
        current: { ...BASELINE, combinedStatus: 'success' },
      }),
    ).toBe(true);
  });
});

describe('isPullRequestTerminal', () => {
  it('returns false for an open non-merged PR', () => {
    expect(isPullRequestTerminal(BASELINE)).toBe(false);
  });

  it('returns true for a closed PR', () => {
    expect(isPullRequestTerminal({ ...BASELINE, state: 'closed' })).toBe(true);
  });

  it('returns true for a merged PR', () => {
    expect(isPullRequestTerminal({ ...BASELINE, merged: true })).toBe(true);
  });
});
