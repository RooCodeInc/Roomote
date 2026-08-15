import { BRAIN_MCP_INSTRUCTIONS } from './brain';

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
});
