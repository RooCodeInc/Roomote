import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('Standard completion-reporting skill guidance', () => {
  it('forbids routine validation status blocks in implement-changes', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'Do not add standalone `Validation`, `Checks`, or `Status` sections for routine successful runs.',
    );
    expect(skillContent).not.toContain(
      'Mention checks only when one failed, was skipped or unavailable, materially changes confidence in the result, or the user explicitly asked for that detail, and when they do matter, mention them inline in the surrounding summary instead of as a dedicated status block.',
    );
  });
});
