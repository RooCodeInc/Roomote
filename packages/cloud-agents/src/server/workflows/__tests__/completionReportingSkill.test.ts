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

  it('requires calibrated completion evidence without fixed report headings', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'Make clear what was completed, what evidence supports it, the scope actually covered, and any material item not verified or still pending.',
    );
    expect(skillContent).toContain(
      'Keep those distinctions in natural prose rather than requiring fixed headings or boilerplate.',
    );
  });
});
