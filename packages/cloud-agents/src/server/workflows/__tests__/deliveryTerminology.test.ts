import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readSkill(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

const legacyDeliveryTerms = [
  ['pre', 'serve'].join(''),
  ['preserv', 'ed'].join(''),
  ['preser', 'vation'].join(''),
];

describe('delivery terminology', () => {
  it('avoids legacy delivery wording in the covered workflow skills', () => {
    const implementSkill = readSkill(
      '../skills/standard/implement-changes/SKILL.md',
    );
    const pushSkill = readSkill('../skills/standard/push/SKILL.md');
    const fixPrSkill = readSkill('../skills/standard/fix-pr/SKILL.md');
    const reviewCodeSkill = readSkill(
      '../skills/standard/review-code/SKILL.md',
    );
    for (const skillContent of [
      implementSkill,
      pushSkill,
      fixPrSkill,
      reviewCodeSkill,
    ]) {
      expect(skillContent).not.toContain(legacyDeliveryTerms[2]!);
    }
  });

  it('keeps the standard workflow skill graph PR-focused', () => {
    const implementSkill = readSkill(
      '../skills/standard/implement-changes/SKILL.md',
    );
    const fixPrSkill = readSkill('../skills/standard/fix-pr/SKILL.md');

    expect(implementSkill).not.toContain('respond-github-issue-comment');
    expect(implementSkill).not.toContain('fix-github-issue');
    expect(fixPrSkill).not.toContain('respond-github-issue-comment');
    expect(fixPrSkill).not.toContain('fix-github-issue');
  });
});
