import {
  resolveStandbyRetentionPolicy,
  selectStandbyEvictions,
} from './standby-retention';

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

describe('resolveStandbyRetentionPolicy', () => {
  it('uses provider defaults when no overrides are configured', () => {
    expect(resolveStandbyRetentionPolicy('docker', {})).toEqual({
      maxCount: 10,
      maxAgeMs: 24 * 60 * 60 * 1_000,
    });
    expect(resolveStandbyRetentionPolicy('blaxel', {})).toEqual({
      maxCount: 25,
      maxAgeMs: 168 * 60 * 60 * 1_000,
    });
  });

  it('applies saved or runtime provider overrides', () => {
    expect(
      resolveStandbyRetentionPolicy('docker', {
        R_DOCKER_STANDBY_MAX_COUNT: '3',
        R_DOCKER_STANDBY_MAX_AGE_HOURS: '12',
      }),
    ).toEqual({ maxCount: 3, maxAgeMs: 12 * 60 * 60 * 1_000 });
  });

  it('falls back safely for invalid values', () => {
    expect(
      resolveStandbyRetentionPolicy('blaxel', {
        R_BLAXEL_STANDBY_MAX_COUNT: '-1',
        R_BLAXEL_STANDBY_MAX_AGE_HOURS: '169',
      }),
    ).toEqual({ maxCount: 25, maxAgeMs: 168 * 60 * 60 * 1_000 });
  });
});
