import {
  BRAIN_MCP_INSTRUCTIONS,
  BRAIN_MCP_READ_INSTRUCTIONS,
  BRAIN_NAMESPACES,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  resolveBrainSourceIdForCollector,
} from './brain';

describe('Brain MCP instructions', () => {
  it('retains Brain-specific recall, tool, provenance, and write guidance', () => {
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'run exactly one `query` about the area you are about to touch before any other context or work tool call',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Once that query returns, the initial Brain preflight is satisfied for the request',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'A tool result, runtime continuation, retry, or continued work on the same topic does not reset it',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Do not call `query`, `entity`, or another Brain tool merely to repeat or reconfirm the preflight',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      "never expose Brain's `source` field or other internal provenance metadata",
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'When recalled context materially shapes the path or approach you choose, casually and concisely mention the specific insight that informed it; do not merely say that memory or history was helpful',
    );
    expect(BRAIN_MCP_INSTRUCTIONS).toContain('save_task_memory');
  });
});

describe('resolveBrainNamespaceId', () => {
  it('buckets a page by the namespace its slug was written under', () => {
    expect(resolveBrainNamespaceId('slack/T123/C456/2026-01-02/1-2')).toBe(
      'slack',
    );
    expect(resolveBrainNamespaceId('people/roomote-member-abc')).toBe('people');
    expect(resolveBrainNamespaceId('daily/digests/2026-01-02')).toBe('daily');
    expect(resolveBrainNamespaceId('linear/org/issues/issue-id')).toBe(
      'linear',
    );
    expect(resolveBrainNamespaceId('discord/123/456/2026-01-02/000')).toBe(
      'discord',
    );
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
    expect(
      resolveBrainSourceIdForCollector('linear-issues:entity-census-v2'),
    ).toBe('linear-issues');
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
    expect(
      resolveBrainSourceIdForCollector(
        'discord-public-channels:entity-timeline-v1:123/456',
      ),
    ).toBe('discord-public-channels');
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
