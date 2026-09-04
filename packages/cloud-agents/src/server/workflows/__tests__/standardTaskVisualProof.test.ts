import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { standardTask } from '../standardTask';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readImplementChangesSkill() {
  return fs.readFileSync(
    path.resolve(thisDirPath, '../skills/standard/implement-changes/SKILL.md'),
    'utf8',
  );
}

describe('Standard Task visual-proof step', () => {
  it('keeps the visual-proof step and delivery inside the active implement-changes workflow', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'For repository-changing work that routes into `implement-changes` while Autonomous mode is active and stays on the parent delivery path, after implementation and before the delegated delivery skill, if repository files changed the active `implement-changes` workflow must load `capture-visual-proof` for one bounded proof step and capture any applicable screenshots or screencasts itself with `agent-browser`. Carry the proof result, or an explicit no-op or blocker result, into the judge pass and the later delivery step instead of bypassing proof. If the run later transitions into `fix-pr`, let that child skill own any required proof step before PR metadata refresh instead of inheriting this parent-owned delivery sequence.',
    );
    expect(harnessInstructions).toContain(
      'For repository-changing `implement-changes` runs that stay on the parent delivery path, after implementation and before the policy-selected delivery skill, if repository files changed the active workflow must load `capture-visual-proof` as one bounded proof step. Browser capture belongs inside that step and follows its `agent-browser` rules.',
    );
    expect(harnessInstructions).toContain(
      'the workflow must not proceed to the judge pass or the delivery skill until `capture-visual-proof` has run or explicitly returned a no-op or blocker result',
    );
    expect(harnessInstructions).toContain(
      'that active workflow owns both the proof step and the delivery transition and must not split them into a second post-completion sequence',
    );
    expect(harnessInstructions).toContain(
      'In Autonomous mode, repository-changing runs keep the active `implement-changes` workflow open so that, after implementation and before delivery, any repository-file change transitions into `capture-visual-proof`, then finish through the delegated `create-draft-pr` skill so it owns commit, push, draft-PR create-or-refresh execution, and PR result reporting.',
    );
    expect(harnessInstructions).toContain(
      "If the run later transitions into `fix-pr`, that child skill owns branch push state, any required `capture-visual-proof` step before PR metadata refresh, PR metadata refresh itself, and PR-fixer closeout instead of inheriting the parent workflow's default PR-delivery finish.",
    );
    expect(harnessInstructions).not.toContain('proof-runner');
    expect(harnessInstructions).not.toContain(
      'must not load or directly use browser tooling',
    );
    expect(harnessInstructions).not.toContain('delegated proof');
  });

  it('keeps screencast auto-classification disabled', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'Screencast auto-classification is disabled for this task.',
    );
    expect(harnessInstructions).not.toContain('background: true');
    expect(harnessInstructions).not.toContain('completion notification');
  });

  it('requires implement-changes to capture proof for repository-file-changing implementations through the skill', () => {
    const skillContent = readImplementChangesSkill();

    expect(skillContent).toContain(
      'If the current implementation pass changed repository files, keep this workflow active by loading `capture-visual-proof` after implementation. That step decides whether visual proof applies, snapshots the diff, captures any applicable screenshots or screencasts with `agent-browser`, uploads them, and returns a proof result before the judge pass and branch/push/PR completion continue.',
    );
    expect(skillContent).toContain(
      'After implementation, check whether repository files actually changed, including newly added files.',
    );
    expect(skillContent).toContain(
      'Do not launch a separate task or subagent for this step.',
    );
    expect(skillContent).toContain(
      'When the implementation changed repository files, the workflow continued in the current task/session by loading `capture-visual-proof` for the shipped change, kept browser capture inside that step on the `agent-browser` path, and returned artifacts or blockers honestly.',
    );
    expect(skillContent).toContain(
      'implement the current change -> check whether repository files changed -> if yes continue in the current task/session by loading `capture-visual-proof` and capturing proof there -> consume any uploaded-artifact evidence or latest proof links for PR embeds when screenshots or screencasts are kept -> refresh PR evidence to the latest relevant proof result for each later UI iteration',
    );
    expect(skillContent).toContain(
      'Do not substitute Playwright, browser devtools, ad hoc localhost scripts, or any other browser automation for the `agent-browser` path defined in `capture-visual-proof`.',
    );
    expect(skillContent).not.toContain('proof-runner');
    expect(skillContent).not.toContain('browser tooling');
    expect(skillContent).not.toContain('delegated proof');
    expect(skillContent).not.toContain('Slack screenshot posting');
  });

  it('requires implement-changes to run the judge after the proof step with images and the diff snapshot', () => {
    const skillContent = readImplementChangesSkill();

    expect(skillContent).toContain(
      'run one focused Task-tool judge pass after the initial self-review and only after any required pre-delivery `capture-visual-proof` step for this shipped change has completed',
    );
    expect(skillContent).toContain(
      'the path `/tmp/capture-visual-proof/diff-at-start.patch` when it exists, and the local paths of every kept screenshot and keyframe so the judge can open them',
    );
    expect(skillContent).toContain(
      'to report undisclosed source drift between the proof snapshot and the shipped diff',
    );
    expect(skillContent).toContain(
      'Treat the judge verdict as review input and fix actionable plan-mismatch, proof, or drift gaps it finds',
    );
    expect(skillContent).toContain(
      'When those judge-driven fixes change repository files, re-run the `capture-visual-proof` step once for the updated shipped change',
    );
    expect(skillContent).toContain(
      'then run one more focused judge pass against the refreshed diff, validation state, and refreshed proof result before delivery',
    );
    expect(skillContent).not.toContain('background visual proof');
  });
});
