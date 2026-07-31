import { createProofRunnerAgentPrompt } from '../proof-runner-prompt';

describe('createProofRunnerAgentPrompt', () => {
  it('returns artifact IDs and explicit parent sharing guidance', () => {
    const prompt = createProofRunnerAgentPrompt('http://127.0.0.1:3000');

    expect(prompt).toContain(
      'the `artifactId`, `viewUrl`, and `rawUrl` returned by its `manage_artifacts` upload result',
    );
    expect(prompt).toContain(
      '`Sharing note`: only when the report contains at least one uploaded artifact, end with this guidance for the parent',
    );
    expect(prompt).toContain(
      'If `send_chat_reply` with `imageArtifactIds` is available and this proof may be relevant to the user in the originating thread, share the screenshot artifact IDs listed above.',
    );
    expect(prompt).toContain(
      'Omit the section entirely when no artifacts were uploaded.',
    );
  });
});
