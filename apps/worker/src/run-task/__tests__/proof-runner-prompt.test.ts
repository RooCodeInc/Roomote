import { createProofRunnerAgentPrompt } from '../proof-runner-prompt';

describe('createProofRunnerAgentPrompt', () => {
  it('requires a full-frame visual quality check before upload', () => {
    const prompt = createProofRunnerAgentPrompt('http://127.0.0.1:3000');

    expect(prompt).toContain(
      'Verify both the specific proof sentence and the full captured frame for obvious visual regressions',
    );
    expect(prompt).toContain(
      'inconsistent light/dark theme treatment, unreadable contrast, clipping or overflow, broken layout, unintended loading or error states',
    );
    expect(prompt).toContain('styling that conflicts with the surrounding UI');
    expect(prompt).toContain(
      'Do not approve or upload an artifact just because its focal element satisfies the proof sentence.',
    );
    expect(prompt).toContain(
      'If the failed self-review is caused by the capture itself, retry the artifact once.',
    );
    expect(prompt).toContain(
      'If the UI is plainly wrong because of the implementation, report that as blocked instead of uploading it as successful proof.',
    );
    expect(prompt).toContain(
      'self-review outcome covering both claim accuracy and full-frame visual quality',
    );
  });

  it('sanctions only the digest-verified feature-demo capture runner', () => {
    const digest = 'a'.repeat(64);
    const prompt = createProofRunnerAgentPrompt(
      'http://127.0.0.1:3000',
      digest,
    );

    expect(prompt).toContain(
      'the feature-demo capture runner at `/tmp/feature-demo/capture.mjs`',
    );
    expect(prompt).toContain(
      'running it via `node` with the environment variables the brief specifies is compliant browser work',
    );
    // The staging path is parent-writable, so the sanction binds to content —
    // and to close the verify/execute race, the runner digests and executes a
    // private copy, never the swappable staging path.
    expect(prompt).toContain('copy the file to a fresh private path first');
    expect(prompt).toContain('sha256sum "$RUNNER"');
    expect(prompt).toContain(
      'execute that verified copy — never the original path',
    );
    expect(prompt).toContain(`\`${digest}\``);
    expect(prompt).toContain('capture runner integrity mismatch');
    expect(prompt).toContain(
      'This exception covers exactly that digest-verified copy and no other script.',
    );
  });

  it('omits the capture-runner sanction entirely without a digest', () => {
    const prompt = createProofRunnerAgentPrompt('http://127.0.0.1:3000');

    expect(prompt).not.toContain('/tmp/feature-demo/capture.mjs');
    expect(prompt).not.toContain('sanctioned exception');
  });

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
