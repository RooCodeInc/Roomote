import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('Capture visual proof skill', () => {
  it('frames parent-invoked proof as a handoff result instead of task completion', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain('<handoff_context>');
    expect(skillContent).toContain(
      "When this skill is invoked by an active parent workflow such as `implement-changes`, its output is a proof handoff result for that parent workflow, not the terminal completion of the user's repository-changing task.",
    );
    expect(skillContent).toContain(
      'After returning a delegated proof result, expect the parent workflow to continue into its required delivery state such as branch push or pull-request creation.',
    );
    expect(skillContent).toContain(
      "Only treat this skill's proof report as the final task answer when the user explicitly invoked `capture-visual-proof` as a standalone proof task.",
    );
    expect(skillContent).toContain(
      '<title>Return the proof handoff result</title>',
    );
    expect(skillContent).toContain(
      'When invoked by a parent workflow, phrase the result as a delegated proof result to carry forward, not as completion of the overall repository-changing task.',
    );
  });

  it('keeps the proof package classification contract', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

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
  });

  it('delegates browser proof to the hidden proof-runner subagent', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain('<subagent_contract>');
    expect(skillContent).toContain(
      'delegate capture to the hidden `proof-runner` subagent with the Task tool',
    );
    expect(skillContent).toContain(
      'Delegate one proof brief per run to the `proof-runner` subagent with the Task tool',
    );
    expect(skillContent).toContain(
      'Browser-session mechanics and CLI syntax belong in the worker-owned `proof-runner` subagent prompt',
    );
    expect(skillContent).not.toContain('proof-capture-config.json');
    expect(skillContent).not.toContain('test -f');
    expect(skillContent).not.toContain('artifact-urls.json');
    expect(skillContent).not.toContain('nativeProofCaptureEnabled');
    expect(skillContent).not.toContain('run-proof-capture.sh');
    expect(skillContent).not.toContain('agent_type="proof-runner"');
  });

  it('retries app-readiness blockers from the parent side before reporting them final', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'treat a delegated proof-runner reachability or readiness blocker as a parent-side handoff',
    );
    expect(skillContent).toContain(
      'Attempt at most one bounded recovery that is directly related to making the intended proof surface reachable from current task context, then retry delegated proof capture once',
    );
    expect(skillContent).toContain(
      'After any single allowed recovery or retry is exhausted, return the blocked proof result immediately.',
    );
  });

  it('prefers real state but allows disclosed simulation without permitting fabricated evidence', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'Prefer genuine application, database, authentication, feature-flag, fixture, test-record, or form-submission state when it is practical to establish',
    );
    expect(skillContent).toContain(
      'transparent simulation may modify application source, hardcode a condition, role, feature state, or network response, mock UI or network responses, or arrange DOM or rendered component state',
    );
    expect(skillContent).toContain(
      "Every simulation, mock, source modification, or hardcoded state must be disclosed explicitly in the proof brief, each affected artifact's proof metadata, and the final proof report",
    );
    expect(skillContent).toContain(
      'Do not add a blanket prohibition on source modifications, simulated payloads, or DOM/rendered-state setup to the delegated proof brief; scope and disclose any simulation instead.',
    );
    expect(skillContent).not.toContain(
      'Do not create source modifications or simulate payload/DOM state.',
    );
    expect(skillContent).toContain(
      'does not prove the real data flow, authorization, backend behavior, network integration, or end-to-end correctness',
    );
    expect(skillContent).toContain(
      'Never fabricate or alter screenshot pixels, invent artifact provenance, conceal how a state was produced',
    );
  });

  it('blocks proof honestly when the proof-runner subagent is unavailable', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'report the proof branch as blocked with blocker type `proof runtime unavailable`',
    );
    expect(skillContent).toContain('proof_runner_unavailable');
    expect(skillContent).toContain(
      'the delegated proof runtime cannot run for this task',
    );
    expect(skillContent).toContain(
      'Do not fall back to parent-issued browser commands, ad hoc capture tools, or any other browser path',
    );
    expect(skillContent).not.toContain('thin_runtime_unavailable');
    expect(skillContent).not.toContain('thin_wrapper_unavailable');
    expect(skillContent).not.toContain('<reviewer_contract>');
    expect(skillContent).not.toContain('proof-reviewer.md');
    expect(skillContent).not.toContain('proof-screencast-reviewer.md');
    expect(skillContent).not.toContain('describe_video');
  });

  it('treats manage_artifacts upload results as the only canonical proof links', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      "Treat artifact URLs in the subagent's report as canonical proof links only when the subagent attributes them to `manage_artifacts` upload tool results",
    );
    expect(skillContent).toContain(
      'Never invent, guess, or reconstruct artifact URLs in the parent workflow.',
    );
    expect(skillContent).toContain(
      'delegate validation of each reported local capture path against its per-shot proof sentence to the `visual` subagent',
    );
    expect(skillContent).not.toContain('Upload helper path');
    expect(skillContent).not.toContain('upload-manifest.json');
  });

  it('carries artifact IDs and optional chat-sharing guidance to the parent', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      "include each screenshot's `artifactId`, `viewUrl`, `rawUrl`, state provenance, and short `Proves` and `Does not prove` statements",
    );
    expect(skillContent).toContain(
      "every retained keyframe's `artifactId`, `viewUrl`, and `rawUrl`",
    );
    expect(skillContent).toContain(
      'When uploaded proof artifacts are present, carry forward a short `Sharing note`',
    );
    expect(skillContent).toContain(
      'when `send_chat_reply` with `imageArtifactIds` is available and the proof may be relevant to the user in the originating thread',
    );
  });

  it('preflights the browser target with a shell probe before spawning the runner', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'probe the planned browser target once with a plain HTTP request from the shell',
    );
    expect(skillContent).toContain(
      'Any real HTTP status code means the surface is up',
    );
    expect(skillContent).toContain(
      'A `000` result, empty output, or a curl error means connection refusal, timeout, or no response — in that case do not spawn the subagent',
    );
    expect(skillContent).toContain(
      'This shell probe is reachability-only — it is not browser tooling and never substitutes for delegated capture.',
    );
  });

  it('caps proof-runner launches at two per proof handoff', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'Launch the `proof-runner` subagent at most twice per proof handoff',
    );
    expect(skillContent).toContain(
      'When two delegated runs have not produced full-coverage proof, return the proof branch blocked with what each run observed instead of launching further runs.',
    );
  });

  it('uses one five-minute budget and returns a blocked timeout handoff', () => {
    const skillContent = read(
      '../skills/standard/capture-visual-proof/SKILL.md',
    );

    expect(skillContent).toContain(
      'The entire visual proof handoff has one hard five-minute deadline, starting when this skill is entered.',
    );
    expect(skillContent).toContain(
      'no phase, retry, or settlement recovery receives a fresh five minutes',
    );
    expect(skillContent).toContain(
      'return a blocked proof handoff with blocker type `proof capture timed out`',
    );
    expect(skillContent).toContain('proof_capture_timed_out');
  });

  it('no longer ships the removed thin-runner reference files', () => {
    for (const removedReference of [
      'thin-proof-runner.md',
      'thin-proof-execution-schema.json',
      'proof-runner.md',
      'proof-execution-schema.json',
    ]) {
      expect(
        fs.existsSync(
          path.resolve(
            thisDirPath,
            `../skills/standard/capture-visual-proof/references/${removedReference}`,
          ),
        ),
      ).toBe(false);
    }
  });
});
