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

  it('allows narrow live-source fallback only for an explicit coverage or freshness gap', () => {
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'the Brain lacks enough coverage, freshness beyond its collection window could materially change the answer, or the user explicitly asks for live verification',
    );
    expect(BRAIN_MCP_INSTRUCTIONS).toContain(
      'do not sweep an entire integration when the Brain already answers the question',
    );
  });
});
