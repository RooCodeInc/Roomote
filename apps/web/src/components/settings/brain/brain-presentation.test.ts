import {
  buildMemorySegments,
  buildNamespaceSegments,
  describeBrainStatus,
  describeSourceStatus,
} from './brain-presentation';

describe('buildNamespaceSegments', () => {
  it('returns nothing when the corpus is empty', () => {
    expect(
      buildNamespaceSegments([
        { id: 'tasks', label: 'Task memories', pages: 0 },
      ]),
    ).toEqual([]);
  });

  it('turns page counts into shares that add up to the whole', () => {
    const segments = buildNamespaceSegments([
      { id: 'slack', label: 'Slack', pages: 75 },
      { id: 'tasks', label: 'Task memories', pages: 25 },
    ]);

    expect(segments.map((segment) => segment.percent)).toEqual([75, 25]);
    expect(
      segments.reduce((total, segment) => total + segment.percent, 0),
    ).toBe(100);
  });

  it('gives every named namespace its own color and leaves the catch-all colorless', () => {
    const segments = buildNamespaceSegments([
      { id: 'slack', label: 'Slack', pages: 3 },
      { id: 'other', label: 'Other', pages: 2 },
      { id: 'tasks', label: 'Task memories', pages: 1 },
    ]);
    const [slack, other, tasks] = segments;

    expect(slack!.color).not.toBe(tasks!.color);
    expect(other!.color).toBe('var(--color-muted-foreground)');
    // The catch-all must not consume a palette slot; the named namespace after
    // it takes the next color rather than skipping one.
    expect(tasks!.color).toBe('var(--color-chart-2)');
  });
});

describe('describeBrainStatus', () => {
  it('separates an outage from a half-configured Brain', () => {
    expect(describeBrainStatus('unreachable').tone).toBe('warning');
    expect(describeBrainStatus('incomplete').label).toBe('Needs attention');
    expect(describeBrainStatus('not_configured').tone).toBe('neutral');
    expect(describeBrainStatus('connected').tone).toBe('ok');
  });
});

describe('describeSourceStatus', () => {
  it('explains every state that is not simply working', () => {
    expect(describeSourceStatus('ingesting').hint).toBeNull();

    for (const status of ['backfilling', 'idle', 'not_connected'] as const) {
      expect(describeSourceStatus(status).hint).toBeTruthy();
    }
  });
});

describe('buildMemorySegments', () => {
  const byStatus = {
    pending: 3,
    processing: 1,
    done: 12,
    skipped: 2,
    failed: 2,
  };

  it('folds the drainer’s in-flight claim into the queue', () => {
    const queued = buildMemorySegments(byStatus).find(
      (segment) => segment.id === 'queued',
    );

    expect(queued?.count).toBe(4);
  });

  it('reports shares of the whole outbox', () => {
    const segments = buildMemorySegments(byStatus);

    expect(segments.map((segment) => segment.count)).toEqual([12, 4, 2, 2]);
    expect(
      segments.reduce((total, segment) => total + segment.percent, 0),
    ).toBeCloseTo(100);
  });

  it('does not divide by zero on a deployment with no memories', () => {
    const segments = buildMemorySegments({
      pending: 0,
      processing: 0,
      done: 0,
      skipped: 0,
      failed: 0,
    });

    expect(segments.every((segment) => segment.percent === 0)).toBe(true);
  });
});
