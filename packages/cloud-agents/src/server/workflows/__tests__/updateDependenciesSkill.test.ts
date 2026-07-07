import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const skillPath = path.resolve(
  thisDirPath,
  '../skills/standard/update-dependencies/SKILL.md',
);

function readSkillContent() {
  return fs.readFileSync(skillPath, 'utf8');
}

describe('update-dependencies guidance', () => {
  it('tells the agent to refresh warmed install state before trusting validation', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'do not assume the current install tree already matches the edited manifests or lockfiles just because a lightweight repeat install succeeds',
    );
    expect(skillContent).toContain(
      "Refresh the repository's authoritative install state before broader validation",
    );
    expect(skillContent).toContain(
      'escalate to `pnpm install --frozen-lockfile --force` when the ordinary reinstall appears to trust stale `.pnpm`, `node_modules`, or symlink state',
    );
    expect(skillContent).toContain(
      'rerun the install once with a clean or forced refresh and repeat the failing validation before treating it as a real blocker',
    );
    expect(skillContent).toContain(
      'Do not mistake warmed-workspace dependency drift for a genuine regression in the proposed update.',
    );
  });
});
