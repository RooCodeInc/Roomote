import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('implement-changes delivery state contract', () => {
  it('requires a concrete delivery end state instead of a local-only finish line', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      '<title>Reach the required branch/push/PR state</title>',
    );
    expect(skillContent).toContain(
      "Continue until the run reaches the concrete branch, push, or pull-request state required by the invoking workflow's execution policy.",
    );
    expect(skillContent).toContain(
      'Continue into the policy-selected delivery outcome instead of treating validated local code changes, a proof result, or a local summary as completion on their own.',
    );
    expect(skillContent).toContain(
      'If repository files changed and the active execution policy still requires push or pull-request delivery, the run is not in a completable state after validation; any local summary before delegated delivery resolves is only a progress update.',
    );
    expect(skillContent).toContain(
      'If validation failed, was skipped, or was unavailable for environmental reasons, and the implementation is still the intended shipped diff, continue into the policy-selected delivery skill and make that validation state reviewer-visible in the delegated PR or push report.',
    );
    expect(skillContent).toContain(
      'If `capture-visual-proof` returned a no-op, non-applicable, unnecessary, or blocked proof result, continue into the policy-selected delivery skill and pass that proof result forward.',
    );
    expect(skillContent).toContain(
      'Treat proof applicability, screenshot or screencast retention, uploaded artifact list output, or blocker output as input to the judge pass and the later delivery-state step, not as a terminal completion signal on its own.',
    );
    expect(skillContent).toContain(
      'A blocked, non-applicable, or unnecessary proof result is not a terminal completion state when repository files changed and the active execution policy still requires push or pull-request delivery.',
    );
    expect(skillContent).toContain(
      'The delegated delivery result must make the validation limitation reviewer-visible; do not end the workflow with a local summary before the required branch, push, or pull-request state is reached.',
    );
    expect(skillContent).toContain(
      'do not report the run as complete while the required delivery path remains pending.',
    );
    expect(skillContent).toContain(
      'The only valid terminal states for a repository-changing run are: delegated delivery completed, an explicit blocker, or an explicit policy pause awaiting user input.',
    );
    expect(skillContent).not.toContain(
      "Branch/push/PR actions were executed or deferred exactly as directed by the invoking workflow's execution policy.",
    );
  });
});
