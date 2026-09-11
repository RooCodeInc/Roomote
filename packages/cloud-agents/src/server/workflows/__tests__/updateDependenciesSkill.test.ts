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

  it('requests matching dependency-update reviewers after creating a Dependabot remediation PR', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      "First inspect `.github/dependabot.yml` and match the alert's package ecosystem and manifest directory to the applicable `updates` entry",
    );
    expect(skillContent).toContain(
      '`.github/renovate.json`, `.github/renovate.json5`, `renovate.json`, `renovate.json5`, `.renovaterc`, and `.renovaterc.json`',
    );
    expect(skillContent).toContain(
      'matching `packageRules` for the affected package, manager or ecosystem, and manifest path',
    );
    expect(skillContent).toContain(
      'effective `reviewers`, `additionalReviewers`, `assignees`, and `additionalAssignees`',
    );
    expect(skillContent).toContain(
      'After `create-draft-pr` (or an explicitly requested PR-delivery skill) returns the GitHub pull request number',
    );
    expect(skillContent).toContain(
      'Call `manage_source_control` with action `request_pull_request_reviewers`',
    );
    expect(skillContent).toContain(
      'passing user logins as `reviewers` and team slugs as `teamReviewers`',
    );
    expect(skillContent).toContain(
      "pass separately configured assignees from the matching dependency-update config into the PR-delivery skill's existing `assignees` contract rather than converting assignees into reviewers",
    );
    expect(skillContent).toContain('Do not infer reviewers from `CODEOWNERS`');
    expect(skillContent).toContain(
      'preserve the existing delivery behavior and finish without an ownership mutation',
    );
  });
});
