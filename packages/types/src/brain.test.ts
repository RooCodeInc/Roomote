import { BRAIN_MCP_INSTRUCTIONS, BRAIN_MCP_READ_INSTRUCTIONS } from './brain';

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
