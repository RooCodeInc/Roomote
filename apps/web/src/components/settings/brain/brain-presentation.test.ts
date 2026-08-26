import {
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

  it('binds color to the namespace, not its rank, and leaves the catch-all colorless', () => {
    const segments = buildNamespaceSegments([
      { id: 'slack', label: 'Slack', pages: 3 },
      { id: 'other', label: 'Other', pages: 2 },
      { id: 'tasks', label: 'Task memories', pages: 1 },
    ]);
    const [slack, other, tasks] = segments;

    expect(slack!.color).not.toBe(tasks!.color);
    expect(other!.color).toBe('var(--color-muted-foreground)');
    // Keyed off the registry, so a namespace keeps its hue when the
    // size-sorted chart order changes between refetches.
    const reordered = buildNamespaceSegments([
      { id: 'tasks', label: 'Task memories', pages: 9 },
      { id: 'slack', label: 'Slack', pages: 1 },
    ]);

    expect(reordered.find((segment) => segment.id === 'slack')!.color).toBe(
      slack!.color,
    );
    expect(reordered.find((segment) => segment.id === 'tasks')!.color).toBe(
      tasks!.color,
    );
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
    expect(describeSourceStatus('ingesting')).toMatchObject({
      label: 'Connected',
      hint: null,
    });
    expect(describeSourceStatus('backfilling').label).toBe('Backfilling');
    expect(describeSourceStatus('idle').label).toBe('Waiting');

    for (const status of ['backfilling', 'idle', 'not_connected'] as const) {
      expect(describeSourceStatus(status).hint).toBeTruthy();
    }
  });
});
