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
      'the feature-demo capture runner staged by the parent at `/tmp/feature-demo/capture.mjs`',
    );

    // The staging path is shared/parent-writable, so the sanction closes the
    // check/use race by reading the file exactly once and executing the same
    // bytes it hashed (a single node process; no separate hash-then-run step,
    // no re-open of the swappable path).
    expect(prompt).toContain('reading the file exactly once');
    expect(prompt).toContain(
      'const b=readFileSync("/tmp/feature-demo/capture.mjs")',
    );
    expect(prompt).toContain(
      `createHash("sha256").update(b).digest("hex")!=="${digest}"`,
    );
    expect(prompt).toContain(
      'await import("data:text/javascript;base64,"+b.toString("base64"))',
    );
    expect(prompt).toContain('capture runner integrity mismatch');
    expect(prompt).toContain(
      'never fall back to `node /tmp/feature-demo/capture.mjs`',
    );
    expect(prompt).toContain(
      'This exception covers exactly this verified-execution command and no other script.',
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
