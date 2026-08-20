import {
  BRAIN_MCP_INSTRUCTIONS,
  BRAIN_MCP_READ_INSTRUCTIONS,
  BRAIN_NAMESPACES,
  brainNamespaceLabel,
  resolveBrainNamespaceId,
  resolveBrainSourceIdForCollector,
} from './brain';

describe('BRAIN_MCP_INSTRUCTIONS', () => {
  it('makes Brain recall a sequential gate before overlapping sources', () => {
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'run one `query` about the area you are about to touch and wait for its result',
    );
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'Never issue the Brain query and an overlapping Slack, GitHub, meeting, task-history, or pull-request lookup in the same parallel batch',
    );
  });

  it('continues to relevant sources when Brain context is incomplete', () => {
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      "Treat Brain as context, not a stopping point; if it doesn't fully answer the question, continue with the relevant sources",
    );
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'do not sweep an entire integration when the Brain already answers the question',
    );
  });

  it('keeps Brain provenance out of user-facing replies', () => {
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      "never expose Brain's `source` field or other internal provenance metadata",
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Do not add a `Source:` line or cite raw Brain metadata',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'cite the underlying user-facing integration directly',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).not.toContain(
      'Cite Brain pages when you rely on them',
    );
  });

  it('exports read guidance without the task-only memory writer', () => {
    expect(BRAIN_MCP_READ_INSTRUCTIONS).toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(BRAIN_MCP_READ_INSTRUCTIONS).not.toContain('save_task_memory');
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(BRAIN_MCP_READ_INSTRUCTIONS);
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
  });

  it('does not invent a namespace for an unrecognised prefix', () => {
    expect(resolveBrainNamespaceId('scratch/whatever')).toBe('other');
    expect(brainNamespaceLabel('other')).toBe('Other');
  });

  it('names every namespace the read instructions tell agents about', () => {
    for (const namespace of BRAIN_NAMESPACES) {
      if (BRAIN_MCP_READ_INSTRUCTIONS.includes(`\`${namespace.prefix}\``)) {
        expect(namespace.label).toBeTruthy();
      }
    }

    // Every namespace the instructions enumerate must be one this registry can
    // label, or the Settings page files those pages under "Other".
    for (const prefix of [
      'people/',
      'tasks/',
      'prs/',
      'slack/',
      'notion/',
      'meetings/',
      'github/',
    ]) {
      expect(resolveBrainNamespaceId(`${prefix}anything`)).not.toBe('other');
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
