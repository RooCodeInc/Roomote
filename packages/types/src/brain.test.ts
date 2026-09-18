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
      'run one `query` about the area you are about to touch and wait for its result',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'An unfamiliar person, project, company, name, or term is a reason to retrieve relevant memory, not to immediately ask the user what it means',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Run the required preflight `query` first, then use the narrowest appropriate lookup for any specific unresolved gap',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Ask for clarification only if bounded retrieval leaves material ambiguity, or the required memory is unavailable and that ambiguity blocks progress',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Do not guess, and do not repeat searches without a specific unresolved gap. This does not replace authorization checks or genuine decisions only the user can make.',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      "never expose Brain's `source` field or other internal provenance metadata",
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'When specific information returned by a Brain memory retrieval materially informs your answer or work, naturally tell the user which remembered fact you retrieved and how you used it',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Do not mention retrieval that did not inform the outcome',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Never expose internal memory IDs, page slugs, storage paths, raw metadata, source fields, or other internal provenance',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Before relying on one, revalidate it with the cheapest authoritative tool call available. Recalled context must never suppress that check.',
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
    expect(resolveBrainSourceIdForCollector('task-memory:initiator-v3')).toBe(
      'task-memories',
    );
    expect(
      resolveBrainSourceIdForCollector('pull-request-facts:occurrence-date-v3'),
    ).toBe('pull-request-facts');
  });
});
