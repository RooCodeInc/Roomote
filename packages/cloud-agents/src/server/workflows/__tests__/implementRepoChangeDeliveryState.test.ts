import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('implement-changes delivery state contract', () => {
  it('requires a concrete delivery end state instead of a local-only finish line', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/resources/default-workflow.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('## 5. Reach the Required Delivery State');
    expect(skillContent).toContain(
      "Continue until the run reaches the concrete branch, push, or pull-request state required by the invoking workflow's execution policy.",
    );
    expect(skillContent).toContain(
      'Local validation, proof, or a summary is not completion when delivery remains required',
    );
    expect(skillContent).toContain(
      'any local summary before delegated delivery resolves is only a progress update.',
    );
    expect(skillContent).toContain(
      'If validation failed, was skipped, or was unavailable for environmental reasons, and the implementation is still the intended shipped diff, continue into the policy-selected delivery skill and make that validation state reviewer-visible in the delegated PR or push report.',
    );
    expect(skillContent).toContain(
      'If `capture-visual-proof` returned a no-op, non-applicable, unnecessary, or blocked proof result, continue into the policy-selected delivery skill and pass that proof result forward.',
    );
    expect(skillContent).toContain(
      'Carry the proof report, canonical uploaded artifact list, and any no-op, non-applicable, unnecessary, or blocked outcome honestly into review and delivery',
    );
    expect(skillContent).toContain('A proof result is input, not completion.');
    expect(skillContent).toContain(
      'an unavailable dependency, service, credential, or tool is a validation gap, not permission to claim success or stop before required delivery.',
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
