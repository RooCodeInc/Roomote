import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readStandardSkill(skillName: string): string {
  return fs.readFileSync(
    path.resolve(thisDirPath, `../skills/standard/${skillName}/SKILL.md`),
    'utf8',
  );
}

describe('standard repository workflows repo-local AGENTS.md contract', () => {
  it.each([
    'implement-changes',
    'plan-repo-implementation',
    'explain-repo-code',
  ])(
    'requires %s to load applicable repo-local AGENTS.md before repository work',
    (skillName) => {
      const skillContent = readStandardSkill(skillName);

      expect(skillContent).toContain(
        'read the applicable repo-local `AGENTS.md` guidance for that path',
      );
      expect(skillContent).toContain(
        "git -C <repo-dir> ls-files -- AGENTS.md '**/AGENTS.md'",
      );
      expect(skillContent).toContain(
        'read the repo root `AGENTS.md` through the nearest ancestor',
      );
      expect(skillContent).toContain(
        'When switching repositories or moving into a different subtree with its own `AGENTS.md`, re-check and read the newly applicable repo-local guidance before continuing.',
      );
    },
  );
});
