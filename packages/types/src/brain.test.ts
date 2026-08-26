import {
  BRAIN_NAMESPACES,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  resolveBrainSourceIdForCollector,
} from './brain';

describe('resolveBrainNamespaceId', () => {
  it('buckets a page by the namespace its slug was written under', () => {
    expect(resolveBrainNamespaceId('slack/T123/C456/2026-01-02/1-2')).toBe(
      'slack',
    );
    expect(resolveBrainNamespaceId('people/roomote-member-abc')).toBe('people');
    expect(resolveBrainNamespaceId('daily/digests/2026-01-02')).toBe('daily');
  });

  it('does not invent a namespace for an unrecognised prefix', () => {
    expect(resolveBrainNamespaceId('scratch/whatever')).toBe('other');
    expect(brainNamespaceLabel('other')).toBe('Other');
  });

  it('provides a label for every registered namespace', () => {
    for (const namespace of BRAIN_NAMESPACES) {
      expect(namespace.label).toBeTruthy();
    }
  });
});

describe('resolveBrainSourceIdForCollector', () => {
  it('survives the version suffix collectors bump when page semantics change', () => {
    expect(
      resolveBrainSourceIdForCollector(
        'slack-public-channels:entity-timeline-v2',
      ),
    ).toBe('slack-public-channels');
    expect(
      resolveBrainSourceIdForCollector('github-issues:occurrence-date-v3'),
    ).toBe('github-issues');
  });

  it('folds a fanned-out collector’s per-partition rows into one source', () => {
    expect(
      resolveBrainSourceIdForCollector(
        'slack-public-channels:entity-timeline-v2:T123/C456',
      ),
    ).toBe('slack-public-channels');
    expect(resolveBrainSourceIdForCollector('notion-pages:incremental')).toBe(
      'notion-pages',
    );
  });

  it('claims nothing for state rows that are not a source', () => {
    expect(resolveBrainSourceIdForCollector('roomote-daily-digest')).toBeNull();
  });

  it('maps the outbox-fed checkpoints back to their sources', () => {
    expect(
      resolveBrainSourceIdForCollector('task-memory:effective-date-v2'),
    ).toBe('task-memories');
    expect(
      resolveBrainSourceIdForCollector('pull-request-facts:occurrence-date-v3'),
    ).toBe('pull-request-facts');
  });
});
