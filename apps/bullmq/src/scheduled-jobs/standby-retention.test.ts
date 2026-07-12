import { selectStandbyEvictions } from './standby-retention';

const now = new Date('2026-07-12T12:00:00.000Z');

function candidate(handle: string, ageHours: number) {
  return {
    runId: Number(handle.slice(1)),
    taskId: `task-${handle}`,
    provider: 'docker' as const,
    handle,
    createdAt: new Date(now.getTime() - ageHours * 60 * 60 * 1_000),
  };
}

describe('selectStandbyEvictions', () => {
  it('evicts expired and over-count standbys while protecting active resumes', () => {
    const candidates = [
      candidate('h1', 1),
      candidate('h2', 2),
      candidate('h3', 3),
      candidate('h4', 30),
    ];

    expect(
      selectStandbyEvictions(
        candidates,
        new Set(['h3']),
        { maxCount: 2, maxAgeMs: 24 * 60 * 60 * 1_000 },
        now,
      ).map(({ handle }) => handle),
    ).toEqual(['h4']);
  });

  it('evicts every unprotected standby when the count is zero', () => {
    expect(
      selectStandbyEvictions(
        [candidate('h1', 1), candidate('h2', 2)],
        new Set(),
        { maxCount: 0, maxAgeMs: 24 * 60 * 60 * 1_000 },
        now,
      ).map(({ handle }) => handle),
    ).toEqual(['h1', 'h2']);
  });
});
