import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { standardTask } from '../standardTask';

describe('Standard Task visual-proof delegation', () => {
  it('keeps visual-proof and delivery handoffs inside the active implement-changes workflow', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'For repository-changing work that routes into `implement-changes` while Autonomous mode is active and stays on the parent delivery path, after implementation and before the delegated delivery skill, if repository files changed the active `implement-changes` workflow must transition into `capture-visual-proof` for one constrained proof step. The parent must not load or directly use browser tooling; carry the delegated screenshot or screencast proof result, or an explicit no-op or blocker result, into the later delivery step instead of bypassing proof or improvising another browser path. If the run later transitions into `fix-pr`, let that child skill own any required delegated proof handoff before PR metadata refresh instead of inheriting this parent-owned delivery sequence.',
    );
    expect(harnessInstructions).toContain(
      'When an active skill delegates to a child skill as one of its own required steps, keep the parent workflow active across that handoff. Do not treat the parent as finished at the delegation boundary, and do not report completion until the delegated child returns the required proof, delivery, or blocker state.',
    );
    expect(harnessInstructions).toContain(
      'For repository-changing `implement-changes` runs that stay on the parent delivery path, after implementation and before the policy-selected delivery skill, if repository files changed the active workflow must transition into `capture-visual-proof` as one constrained proof step, and the parent workflow must not load or directly use browser tooling.',
    );
    expect(harnessInstructions).toContain(
      'For repository-changing `implement-changes` runs that stay on the parent delivery path, the workflow must not proceed to the delivery skill until `capture-visual-proof` has run or explicitly returned a no-op or blocker result. A proof no-op, non-applicable result, unnecessary result, or blocker is not a final closeout; it must be carried into delegated delivery when repository files changed and Autonomous mode still requires push or pull-request delivery. The wrapper sets the delivery policy, but that active workflow owns both child transitions and must not split them into a second post-completion sequence. When the run transitions into `fix-pr`, let that child skill own any required delegated proof handoff before PR metadata refresh and the rest of the PR-fixer closeout.',
    );
    expect(harnessInstructions).toContain(
      'In Autonomous mode, repository-changing runs keep the active `implement-changes` workflow open so that, after implementation and before delivery, any repository-file change transitions into `capture-visual-proof`, then finish through the delegated `create-draft-pr` skill so it owns commit, push, draft-PR create-or-refresh execution, and PR result reporting.',
    );
    expect(harnessInstructions).toContain(
      "If the run later transitions into `fix-pr`, that child skill owns branch push state, any required delegated `capture-visual-proof` handoff before PR metadata refresh, PR metadata refresh itself, and PR-fixer closeout instead of inheriting the parent workflow's default PR-delivery finish.",
    );
    expect(harnessInstructions).not.toContain(
      'After `implement-changes` finishes, if the shipped implementation changed repository files',
    );
  });

  it('surfaces the screencast auto-classification flag state in harness instructions', () => {
    const enabledInstructions = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      visualProofAutoScreencastEnabled: true,
    }).harnessInstructions;
    const disabledInstructions = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      visualProofAutoScreencastEnabled: false,
    }).harnessInstructions;

    expect(enabledInstructions).toContain(
      'Screencast auto-classification is enabled for this task.',
    );
    expect(disabledInstructions).toContain(
      'Screencast auto-classification is disabled for this task.',
    );
  });

  it('keeps the harness instructions byte-identical when backgroundProofCaptureEnabled is false or omitted', () => {
    const baseInput = {
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    };

    const defaultInstructions = standardTask(baseInput).harnessInstructions;
    const disabledInstructions = standardTask({
      ...baseInput,
      backgroundProofCaptureEnabled: false,
    }).harnessInstructions;

    expect(disabledInstructions).toBe(defaultInstructions);
    expect(disabledInstructions).not.toContain('background: true');
    expect(disabledInstructions).not.toContain('completion notification');
    expect(disabledInstructions).toContain(
      'after implementation and before the delegated delivery skill, if repository files changed the active `implement-changes` workflow must transition into `capture-visual-proof` for one constrained proof step',
    );
    expect(disabledInstructions).toContain(
      'the workflow must not proceed to the delivery skill until `capture-visual-proof` has run or explicitly returned a no-op or blocker result',
    );
  });

  it('switches autonomous runs to background proof capture after delivery when backgroundProofCaptureEnabled is true', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      backgroundProofCaptureEnabled: true,
    });

    // Delivery no longer waits on proof.
    expect(harnessInstructions).toContain(
      'after implementation and validation the active `implement-changes` workflow must proceed directly to the delegated delivery skill without waiting for visual proof',
    );
    expect(harnessInstructions).toContain(
      "launch the `capture-visual-proof` delegation with the task tool's `background: true` parameter",
    );
    expect(harnessInstructions).toContain(
      'post the closeout noting the pull request link and that visual proof is being captured in the background and will follow in this thread',
    );
    // The background launch does not discharge the proof obligation.
    expect(harnessInstructions).toContain(
      'Launching in the background does not discharge the proof obligation',
    );
    expect(harnessInstructions).toContain(
      'a synthetic `<task ...>` result injected into the session',
    );
    expect(harnessInstructions).toContain(
      'verify the uploaded artifact URLs from the report, update the pull request body with the proof screenshots and links via `manage_source_control`',
    );
    expect(harnessInstructions).toContain(
      'make the proof visible in the conversation thread by sharing screenshots with `send_chat_reply` via `imageArtifactIds` and using artifact `viewUrl`/`rawUrl` links in the reply text for non-image proof',
    );
    expect(harnessInstructions).toContain(
      'update the pull request body with a short `no visual proof: <reason>` note and say so in the thread',
    );
    // The foreground proof-before-delivery ordering is fully replaced.
    expect(harnessInstructions).not.toContain(
      'after implementation and before the delegated delivery skill, if repository files changed the active `implement-changes` workflow must transition into `capture-visual-proof` for one constrained proof step',
    );
    expect(harnessInstructions).not.toContain(
      'the workflow must not proceed to the delivery skill until `capture-visual-proof` has run or explicitly returned a no-op or blocker result',
    );
    expect(harnessInstructions).not.toContain(
      'keep the active `implement-changes` workflow open through any required delegated proof and',
    );
  });

  it('keeps Interactive mode on the foreground proof flow even when backgroundProofCaptureEnabled is true', () => {
    const baseInput = {
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      interactiveMode: true,
    };

    const withFlag = standardTask({
      ...baseInput,
      backgroundProofCaptureEnabled: true,
    }).harnessInstructions;
    const withoutFlag = standardTask(baseInput).harnessInstructions;

    expect(withFlag).toBe(withoutFlag);
    expect(withFlag).not.toContain('background: true');
    expect(withFlag).toContain(
      'In Interactive mode, repository-changing runs keep the active `implement-changes` workflow open so that, after implementation and before any final delivery pause, any repository-file change transitions into `capture-visual-proof`',
    );
  });

  it('documents the background delegation contract in the capture-visual-proof skill', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/capture-visual-proof/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('<background_delegation>');
    expect(skillContent).toContain(
      'the delegation step passes `background: true` on the Task tool call that launches the `proof-runner` subagent',
    );
    expect(skillContent).toContain(
      'carries the same final report contract as a foreground run: uploaded `manage_artifacts` artifact URLs or an explicit blocker',
    );
    expect(skillContent).toContain(
      'live in the active workflow instructions, not in this skill',
    );
    expect(skillContent).toContain(
      'The bounded-recovery and single-retry rules in this skill apply unchanged to a background proof run.',
    );
  });

  it('requires implement-changes to hand repository-file-changing implementations to capture-visual-proof without exposing browser tooling in the parent', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'If the current implementation pass changed repository files, keep this workflow active by transitioning into `capture-visual-proof` after implementation and let that delegated proof path decide whether visual proof applies, what screenshots or screencasts are needed, what surfaces or states need capture, and whether any internal browser work is required before branch/push/PR completion continues.',
    );
    expect(skillContent).toContain(
      'After implementation, check whether repository files actually changed, including newly added files.',
    );
    expect(skillContent).toContain(
      'Treat proof applicability, screenshot or screencast retention, uploaded artifact list output, or blocker output as input to the later delivery-state step, not as a terminal completion signal on its own.',
    );
    expect(skillContent).toContain(
      'If repository files changed, continue in the current task/session by transitioning into `capture-visual-proof` and pass forward the final shipped change for proof planning and capture before PR update or other completion steps that depend on proof results continue. Do not launch a separate task for this handoff.',
    );
    expect(skillContent).toContain(
      'When the implementation changed repository files, the workflow continued in the current task/session by handing the shipped change to `capture-visual-proof`, kept browser tooling contained inside that delegated proof path, and let the delegated proof path return artifacts or blockers honestly.',
    );
    expect(skillContent).toContain(
      'implement the current change -> check whether repository files changed -> if yes continue in the current task/session by transitioning into `capture-visual-proof` -> consume any returned uploaded-artifact evidence or latest proof links for PR embeds when screenshots or screencasts are kept -> refresh PR evidence to the latest relevant delegated result for each later UI iteration',
    );
    expect(skillContent).toContain(
      'If the delegated proof run returns that the environment-provided browser target is blocked or that browser capture could not complete, carry that blocker forward honestly instead of improvising another browser tool or host.',
    );
    expect(skillContent).toContain(
      'Do not switch to Playwright, manual browser use, browser devtools, or any other browser automation path for visual proof in this workflow; only the delegated `capture-visual-proof` flow may use the approved internal browser path.',
    );
    expect(skillContent).toContain(
      'If pull-request-backed UI work needs proof embeds, consume the delegated result and carry the canonical uploaded artifact list from the delegated proof handoff forward when it exists so the PR formatter can render the latest screenshots and screencasts consistently.',
    );
    expect(skillContent).not.toContain('Slack screenshot posting');
  });

  it('requires implement-changes to run the judge after pre-delivery visual proof and include proof verification', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'run one focused Task-tool judge pass after the initial self-review and only after any required pre-delivery `capture-visual-proof` handoff for this shipped change has completed',
    );
    expect(skillContent).toContain(
      'using the final shipped diff, the validation state, and the latest visual-proof result',
    );
    expect(skillContent).toContain(
      'Ask it specifically to compare plan versus built result and to verify visual proof when evidence was captured or when proof should have applied',
    );
    expect(skillContent).toContain(
      'Treat the judge verdict as review input and fix actionable plan-mismatch or proof gaps it finds',
    );
    expect(skillContent).toContain(
      'When those judge-driven fixes change repository files and this run requires a pre-delivery `capture-visual-proof` handoff, re-run that pre-delivery handoff for the updated shipped change',
    );
    expect(skillContent).toContain(
      'then run one more focused judge pass against the refreshed diff, validation state, and refreshed proof result before delivery',
    );
    expect(skillContent).toContain(
      'When those judge-driven fixes change repository files and background visual proof is configured to run after delivery, do not re-run a pre-delivery proof handoff or block delivery on proof',
    );
    expect(skillContent).toContain(
      'let the post-delivery background `capture-visual-proof` capture that final shipped state',
    );
  });
});
