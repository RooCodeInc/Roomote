import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('Capture visual proof skill', () => {
  const skillContent = read('../skills/standard/capture-visual-proof/SKILL.md');

  it('frames parent-invoked proof as a result to carry forward instead of task completion', () => {
    expect(skillContent).toContain('<handoff_context>');
    expect(skillContent).toContain(
      "When this skill is invoked by an active parent workflow such as `implement-changes` or `fix-pr`, its output is a proof result for that parent workflow, not the terminal completion of the user's repository-changing task.",
    );
    expect(skillContent).toContain(
      "Only treat this skill's proof report as the final task answer when the user explicitly invoked `capture-visual-proof` as a standalone proof task.",
    );
    expect(skillContent).toContain('<title>Return the proof result</title>');
    expect(skillContent).toContain(
      'phrase the result as a proof result to carry forward into the judge pass and delivery, not as completion of the overall repository-changing task',
    );
  });

  it('captures directly with agent-browser instead of delegating to a subagent', () => {
    expect(skillContent).toContain(
      '`agent-browser` is a command-line executable invoked from the shell, and it is the only allowed browser automation path.',
    );
    expect(skillContent).toContain(
      'load the `agent-browser` skill once with the Skill tool, or run `agent-browser skills get core --full` when that skill is unavailable',
    );
    expect(skillContent).not.toContain('proof-runner');
    expect(skillContent).not.toContain('<subagent_contract>');
    expect(skillContent).not.toContain('<background_delegation>');
    expect(skillContent).not.toContain('Task tool');
    expect(skillContent).not.toContain('proof brief');
  });

  it('keeps browser output out of the transcript and leaves image review to the judge', () => {
    expect(skillContent).toContain(
      'Write screenshots, recordings, and keyframes to files under `/tmp/capture-visual-proof/`, never print image bytes',
    );
    expect(skillContent).toContain(
      'Do not read the captured images back yourself; the judge does that.',
    );
  });

  it('snapshots the diff before capture so the judge can detect undisclosed drift', () => {
    // The snapshot must cover committed work too: fix-pr commits and pushes
    // before this step, so `git diff HEAD` alone would be empty there.
    // Shared-root workspaces append one repository after another, so the
    // file is initialized once and every diff uses `>>`.
    expect(skillContent).toContain(
      'mkdir -p /tmp/capture-visual-proof && : > /tmp/capture-visual-proof/diff-at-start.patch',
    );
    expect(skillContent).toContain(
      'git diff "$(git merge-base HEAD origin/HEAD 2>/dev/null || git rev-parse --verify -q HEAD~1 || git hash-object -t tree /dev/null)" >> /tmp/capture-visual-proof/diff-at-start.patch',
    );
    expect(skillContent).not.toContain('" > /tmp/capture-visual-proof/');
    expect(skillContent).toContain(
      "a second repository must never truncate the first repository's snapshot",
    );
    expect(skillContent).toContain('Do not snapshot only `git diff HEAD`');
    // Untracked files must be captured by content, not as a path list, or a
    // new source file would surface as drift once it is staged for delivery.
    expect(skillContent).toContain(
      'git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index -- /dev/null {} >> /tmp/capture-visual-proof/diff-at-start.patch',
    );
    expect(skillContent).not.toContain(
      'git ls-files --others --exclude-standard >>',
    );
    expect(skillContent).toContain(
      'Any source change you make after the snapshot, whether for simulation or for a fix, must be listed in the `Simulation disclosure` section or reverted before this skill returns.',
    );
    expect(skillContent).toContain(
      'The diff snapshot exists and every source change made after it is disclosed or reverted.',
    );
  });

  it('keeps the proof package classification contract', () => {
    expect(skillContent).toContain(
      'Classify the proof package as `screenshot-only`, `screencast-only`, `both`, or `not applicable`.',
    );
    expect(skillContent).toContain(
      "Only consider `screencast-only` or `both` when either the harness reports that screencast auto-classification is enabled for this task or the user's task request explicitly asks for a screencast, recording, or video. Otherwise restrict the choice to `screenshot-only` or `not applicable`.",
    );
    expect(skillContent).toContain(
      'Use `screenshot-only` when one or more stable visible browser states are enough to prove the claim',
    );
    expect(skillContent).toContain(
      'Use `screencast-only` when the claim depends on interaction, timing, animation, navigation, redirect, persistence, revisit, resume, replay, or another temporal sequence',
    );
    expect(skillContent).toContain('coverage checklist');
    expect(skillContent).toContain(
      'Do not silently narrow a broad claim to the first easy visible example.',
    );
    expect(skillContent).toContain('When in doubt, capture one screenshot.');
  });

  it('prefers real state but allows disclosed simulation without permitting fabricated evidence', () => {
    expect(skillContent).toContain(
      'Prefer genuine application, database, authentication, feature-flag, fixture, test-record, or form-submission state when it is practical to establish',
    );
    expect(skillContent).toContain(
      'transparent simulation may modify application source, hardcode a condition, role, feature state, or network response, mock UI or network responses, or arrange DOM or rendered component state',
    );
    expect(skillContent).toContain(
      "Every simulation, mock, source modification, or hardcoded state must be disclosed explicitly in each affected artifact's proof metadata and in the final proof report",
    );
    expect(skillContent).toContain(
      'does not prove the real data flow, authorization, backend behavior, network integration, or end-to-end correctness',
    );
    expect(skillContent).toContain(
      'Never fabricate or alter screenshot pixels, invent artifact provenance, conceal how a state was produced',
    );
  });

  it('allows exactly one recapture and stops on unreachable surfaces', () => {
    expect(skillContent).toContain(
      'Recapture an artifact once when the first honest capture is obviously blank, clipped, or misses the required visible state. That is the only retry this skill allows.',
    );
    expect(skillContent).toContain(
      'inspect the port or current HTTP response once, then return blocked with blocker type `browser surface unavailable`',
    );
    expect(skillContent).toContain(
      'Do not loop on retries or improvise a different surface.',
    );
    expect(skillContent).not.toContain('bounded recovery');
  });

  it('uses one five-minute budget and returns a blocked timeout result', () => {
    expect(skillContent).toContain(
      'The entire visual proof step has one hard five-minute deadline, starting when this skill is entered.',
    );
    expect(skillContent).toContain(
      'no phase or retry receives a fresh five minutes',
    );
    expect(skillContent).toContain(
      'return a blocked proof result with blocker type `proof capture timed out`',
    );
    expect(skillContent).toContain('proof_capture_timed_out');
  });

  it('treats manage_artifacts upload results as the only canonical proof links', () => {
    expect(skillContent).toContain(
      'Treat the `artifactId`, `viewUrl`, and `rawUrl` values returned by each upload tool result as the only canonical artifact references. Never invent, guess, or reconstruct artifact IDs or URLs.',
    );
    expect(skillContent).toContain(
      'using the `upload` action and `type` set to `visual-proof`',
    );
  });

  it('keeps the report contract that PR formatters and the judge consume', () => {
    for (const section of [
      '`Summary`',
      '`Blocked`',
      '`Coverage`',
      '`Simulation disclosure`',
      '`Screenshots` when present',
      '`Screencasts` when present',
      '`Sharing note` when artifacts were uploaded',
      '`Other evidence note`',
      '`Cleanup` only when temporary setup could not be removed',
    ]) {
      expect(skillContent).toContain(section);
    }
    expect(skillContent).toContain(
      'For each uploaded screenshot include its local path, `artifactId`, `viewUrl`, `rawUrl`, state provenance, and short `Proves` and `Does not prove` statements.',
    );
    expect(skillContent).toContain(
      "every retained keyframe's local path, `artifactId`, `viewUrl`, and `rawUrl`",
    );
    expect(skillContent).toContain(
      'When uploaded proof artifacts are present, carry forward a short `Sharing note`',
    );
    expect(skillContent).toContain(
      'when `send_chat_reply` with `imageArtifactIds` is available and the proof may be relevant to the user in the originating thread',
    );
    expect(skillContent).toContain(
      'Choose `Blocker type` from: `proof capture timed out`, `proof runtime unavailable`, `browser surface unavailable`, `browser surface broken`, `claim not visually provable`, `state not reachable on current browser surface`, `fixture missing on current browser surface`, `external side effect risk`, or `upload failed`.',
    );
  });

  it('stays small enough to read as a capture recipe', () => {
    // Down from ~38 KB when the skill orchestrated a delegated runner.
    expect(skillContent.length).toBeLessThan(16_000);
    expect(skillContent.match(/<rule>/g)?.length ?? 0).toBeLessThanOrEqual(16);
  });

  it('no longer ships removed reference files', () => {
    expect(
      fs.existsSync(
        path.resolve(
          thisDirPath,
          '../skills/standard/capture-visual-proof/references',
        ),
      ),
    ).toBe(false);
  });
});
