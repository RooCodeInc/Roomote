---
name: capture-visual-proof
description: Decide whether browser proof applies to a shipped change, capture screenshots or screencasts directly with agent-browser, upload them, and return an honest proof result for the parent workflow and the judge.
---

<role>
Capture the smallest honest proof with `agent-browser`, upload via `manage_artifacts`, and report how the state was produced. The `judge` later checks the images against the claim.
</role>

<handoff_context>
<rule>When this skill is invoked by an active parent workflow such as `implement-changes` or `fix-pr`, its output is a proof result for that parent workflow, not the terminal completion of the user's repository-changing task. Finish the report (including no-op or blocked results) before the Task tool invokes `judge`: this ends the proof deadline, not uploads. Without a judge, load the next workflow skill before continuing. Reload `capture-visual-proof` after judge-driven source changes.</rule>
<rule>Only treat this skill's proof report as the final task answer when the user explicitly invoked `capture-visual-proof` as a standalone proof task.</rule>
</handoff_context>

<execution_context>
<rule>The entire visual proof step has one hard five-minute deadline, starting when this skill is entered. Applicability, setup, capture, the single allowed recapture, and upload all consume that same budget; no phase or retry receives a fresh five minutes. If the deadline expires, stop proof work immediately, do not retry, and return a blocked proof result with blocker type `proof capture timed out` so the parent workflow can continue without visual proof.</rule>
<rule>Derive the browser target from the current environment instructions and use the exact sandbox-local browser URL they specify. Preserve the configured hostname literally: if the environment says `localhost`, use `localhost`; if it says `127.0.0.1`, use `127.0.0.1`. Do not capture proof against external preview URLs unless the public proxy or hostname itself is part of the claim.</rule>
<rule>Capture proof in the real product surface where the behavior lives. Use Storybook only when the user asked for it, the change itself is Storybook-scoped, or the product surface is unreachable for infrastructure reasons and a checked-in story proves the same rendered claim. Label any such evidence `Storybook fallback proof`. Never use Storybook when the product surface is reachable and the shipped UI is failing the claim.</rule>
<rule>`agent-browser` is a command-line executable invoked from the shell, and it is the only allowed browser automation path. Do not use Playwright, browser DevTools, curl-only screenshot substitutes, or any other browser automation path. Before the first browser command, load the `agent-browser` skill once with the Skill tool, or run `agent-browser skills get core --full` when that skill is unavailable, and follow that guidance for session, wait, snapshot, screenshot, and recording commands.</rule>
<rule>Keep browser output out of the transcript. Write screenshots, recordings, and keyframes to files under `/tmp/capture-visual-proof/`, never print image bytes, and use `agent-browser snapshot -i` only when you need to verify page state or find an element. Do not read the captured images back yourself; the judge does that.</rule>
<rule>Before the first browser command, snapshot the complete shipped diff, committed and uncommitted, against the branch base. Initialize the snapshot file once: `mkdir -p /tmp/capture-visual-proof && : > /tmp/capture-visual-proof/diff-at-start.patch`. Then, from inside each repository (every repository in a shared-root workspace), append its diff: `git diff "$(git merge-base HEAD origin/HEAD 2>/dev/null || git rev-parse --verify -q HEAD~1 || git hash-object -t tree /dev/null)" >> /tmp/capture-visual-proof/diff-at-start.patch; git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index -- /dev/null {} >> /tmp/capture-visual-proof/diff-at-start.patch; true`. Always append with `>>`; a second repository must never truncate the first repository's snapshot. The fallbacks cover a missing `origin/HEAD` and a single-commit history, and the second command records every untracked file as a full addition so a new source file is compared by content rather than listed by name. Do not snapshot only `git diff HEAD`: workflows such as `fix-pr` commit and push before this step, and an empty snapshot would make the judge flag every shipped file as drift. The judge compares that snapshot with the delivery diff. Any source change you make after the snapshot, whether for simulation or for a fix, must be listed in the `Simulation disclosure` section or reverted before this skill returns.</rule>
<rule>Follow this state-establishment sequence: (1) attempt genuine application, database, authentication, feature-flag, fixture, test-record, or form-submission state when practical; (2) if that fails, produce disclosed simulated proof on the actual UI through source changes, hardcoded state or responses, UI/network mocks, or DOM/rendered setup; (3) declare proof blocked only when neither genuine nor representative simulated/rendered proof is possible. An infrastructure defect may be reported as degraded capability when independently useful, but not as blocking UI proof while fallback remains. Reporting a platform issue never terminates or replaces fallback proof work.</rule>
<rule>Every simulation, mock, source modification, or hardcoded state must be disclosed explicitly in each affected artifact's proof metadata and in the final proof report. State separately that the artifact proves only visual appearance, layout, or interaction under the disclosed simulated state and does not prove the real data flow, authorization, backend behavior, network integration, or end-to-end correctness. Remove temporary simulation changes before returning, and report any cleanup you could not complete under `Cleanup`.</rule>
<rule>Never fabricate or alter screenshot pixels, invent artifact provenance, conceal how a state was produced, or claim that simulated evidence came from a real application, database, authentication, backend, or network path.</rule>
<rule>When the proof target requires authentication, treat sign-in as part of normal execution rather than as a blocker. Use the environment-provided authentication path when one exists, or fill the available test credentials directly, and wait for the authenticated state to settle before continuing.</rule>
<rule>Treat every browser interaction as unconfirmed until the page shows the expected response. When a verified interaction had no effect, retry the same intent through a different input path (keyboard activation, explicit pointer events, or dispatched input/change events) before concluding the application is at fault.</rule>
<rule>If the captured UI shows the code change itself is wrong, return to implementation instead of presenting that as a terminal proof blocker. An obvious visual defect anywhere in a captured frame, such as broken layout, clipping, unreadable contrast, inconsistent theme treatment, or an unintended loading or error state, is a finding to report, not something to crop out.</rule>
</execution_context>

<workflow>
  <phase name="applicability">
    <steps>
      <step number="1">
        <title>Define the proof scope and decide applicability</title>
        <actions>
          <action>State the shipped change and the claim to prove in one or two sentences.</action>
          <action>Use your judgment to choose screenshots, video, both, or no visual proof according to what best demonstrates the work. Screenshots suit stable appearance; video is useful for motion and interactions and need not be explicitly requested. Skip visual proof when it would not add useful evidence.</action>
          <action>When browser proof is not applicable, skip capture and return the proof result immediately with one short `Other evidence note` naming the strongest non-visual evidence already in context.</action>
          <action>Report the proof package as `screenshot-only`, `screencast-only`, `both`, or `not applicable`. For capture, keep a short coverage checklist listing every materially distinct visible state or treatment the stated claim spans.</action>
        </actions>
      </step>
    </steps>
  </phase>
  <phase name="capture">
    <steps>
      <step number="2">
        <title>Reach the state and capture</title>
        <actions>
          <action>Snapshot the diff, load the `agent-browser` guidance, then open the configured browser target and confirm it is up with `agent-browser get url` or `agent-browser snapshot -i`.</action>
          <action>If the target is unreachable, inspect its port or HTTP response once, then return blocked with blocker type `browser surface unavailable` and the observed error. If the UI responds but genuine state is unavailable or broken, use a disclosed simulated/rendered fallback before considering proof blocked. Do not loop on retries or improvise a different surface.</action>
          <action>Make at most two focused attempts per checklist state across genuine setup and fallback; mark it unproved only when neither genuine nor representative simulated/rendered proof is possible.</action>
          <action>Capture one artifact per checklist item, or one artifact that clearly shows several items together. For screencasts, start recording before the interaction that matters, stop as soon as the proof is visible, validate the clip with `ffprobe`, and extract 3 to 5 keyframes under `/tmp/capture-visual-proof/`.</action>
          <action>For animation detail, read [Higher-FPS recording](resources/high-fps-recording.md): opt-in native `--fps 60`, MP4 delivery, and genuine cadence/pacing checks. Keep ordinary capture at its default.</action>
          <action>For locally produced screencasts only, prefer an H.264 MP4 copy using `-c:v libx264 -pix_fmt yuv420p -preset veryfast -movflags +faststart`. Keep the native WebM source. Stay within the remaining five-minute budget; do not install tools or extend the deadline. If conversion is unavailable, fails, or would leave insufficient time, upload the native WebM instead. Preserve content: no retiming, cuts, overlays, or fabricated pixels. Validate the final clip with `ffprobe` and extract keyframes from that clip. This is not a rule to convert arbitrary uploads or existing artifacts.</action>
          <action>Recapture an artifact once when the first honest capture is obviously blank, clipped, or misses the required visible state. That is the only retry this skill allows.</action>
          <action>If you capture only partial supporting evidence and the remaining checklist items cannot be shown honestly, return the result as blocked with the covered and missing items instead of reporting a narrowed success.</action>
        </actions>
      </step>
      <step number="3">
        <title>Upload</title>
        <actions>
          <action>Upload each screenshot, screencast, and keyframe with the `manage_artifacts` MCP tool using the `upload` action and `type` set to `visual-proof`.</action>
          <action>Treat the `artifactId`, `viewUrl`, and `rawUrl` values returned by each upload tool result as the only canonical artifact references. Never invent, guess, or reconstruct artifact IDs or URLs. When an upload fails, retry it once with the verified local path, then report blocker type `upload failed` with the exact error.</action>
        </actions>
      </step>
    </steps>
  </phase>
  <phase name="reporting">
    <steps>
      <step number="4">
        <title>Return the proof result</title>
        <actions>
          <action>When invoked by a parent workflow, phrase the result as a proof result to carry forward into the judge pass and delivery, not as completion of the overall repository-changing task.</action>
          <action>Keep the result artifact-first and concise. Use these sections: `Summary`, `Blocked` (`true` or `false`, with a `Blocker type` when blocked), `Coverage` (claim scope, covered checklist items, missing items), `Simulation disclosure` (always present: state whether the captured state was genuine or simulated, and list every source change made after the diff snapshot), `Screenshots` when present, `Screencasts` when present, `Sharing note` when artifacts were uploaded, `Other evidence note` when browser proof was not applicable, and `Cleanup` only when temporary setup could not be removed.</action>
          <action>For each uploaded screenshot include its local path, `artifactId`, `viewUrl`, `rawUrl`, state provenance, and short `Proves` and `Does not prove` statements. For each screencast include the same plus every retained keyframe's local path, `artifactId`, `viewUrl`, and `rawUrl`.</action>
          <action>Choose `Blocker type` from: `proof capture timed out`, `proof runtime unavailable`, `browser surface unavailable`, `browser surface broken`, `claim not visually provable`, `state not reachable on current browser surface`, `fixture missing on current browser surface`, `external side effect risk`, or `upload failed`. Use `proof runtime unavailable` when the `agent-browser` guidance or executable cannot be loaded.</action>
          <action>When proof artifacts exist, note that uploads are not shared automatically. Include screenshot IDs via `report_to_parent_session` when available, or via `send_chat_reply` when relevant to a direct chat; link non-image proof in the report or reply.</action>
          <action>Do not mention unuploaded scratch captures or temporary workspace paths other than the local paths of the artifacts you report.</action>
        </actions>
      </step>
    </steps>
  </phase>
</workflow>

<completion_criteria>
<criterion>The claim is classified as `browser proof applicable` or `browser proof not applicable`, and the package as `screenshot-only`, `screencast-only`, `both`, or `not applicable`.</criterion>
<criterion>When proof applies, every materially distinct checklist item is covered by an uploaded artifact, or the result is blocked with the covered and missing items named.</criterion>
<criterion>Artifact references come only from `manage_artifacts` upload results, and the local paths of the kept artifacts are reported for the judge.</criterion>
<criterion>The diff snapshot exists and every source change made after it is disclosed or reverted.</criterion>
<criterion>When invoked by a parent workflow, the output is framed as a proof result rather than terminal completion of the parent task.</criterion>
</completion_criteria>

<error_handling>
<scenario name="proof_capture_timed_out"><problem>The five-minute deadline expired.</problem><recovery>Stop immediately, do not retry, and return blocked with blocker type `proof capture timed out`.</recovery></scenario>
<scenario name="proof_runtime_unavailable"><problem>The `agent-browser` skill guidance or executable cannot be loaded.</problem><recovery>Return blocked with blocker type `proof runtime unavailable` naming what is missing. Do not fall back to another browser path.</recovery></scenario>
<scenario name="browser_surface_unavailable"><problem>The target does not respond, or genuine state is broken.</problem><recovery>If no UI responds, return `browser surface unavailable`. If it responds, try disclosed simulated/rendered proof before returning `browser surface broken`. An infrastructure report alone is not a blocked proof result.</recovery></scenario>
<scenario name="implementation_defect_visible"><problem>The captured UI shows the shipped change is wrong or has an obvious visual defect.</problem><recovery>Return to implementation with the defect described; do not upload the defective frame as successful proof.</recovery></scenario>
</error_handling>
