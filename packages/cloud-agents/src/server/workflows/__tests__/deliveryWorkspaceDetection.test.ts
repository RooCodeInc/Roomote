import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readSkill(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('delivery workspace detection', () => {
  it('covers owner/repo-nested workspaces in delivery skills', () => {
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');
    const pushSkill = readSkill('../skills/standard/push/SKILL.md');

    for (const skillContent of [createDraftPrSkill, createPrSkill, pushSkill]) {
      expect(skillContent).toContain('workspace_root=$(pwd);');
      expect(skillContent).toContain('shopt -s nullglob;');
      expect(skillContent).toContain('for repo_dir in */; do');
      expect(skillContent).toContain(
        'cd "$workspace_root"; for owner_dir in */; do',
      );
      expect(skillContent).toContain(
        'cd "$workspace_root"; for repo_dir in "$owner_dir"*/; do',
      );
      expect(skillContent).toContain(
        'if [ ! -d "$workspace_root/${owner_dir}.git" ]; then',
      );
      expect(skillContent).toContain(
        'if [ -d "$workspace_root/${repo_dir}.git" ]; then',
      );
      expect(skillContent).toContain('cd "$workspace_root/$repo_dir";');
      expect(skillContent).toContain(
        'echo "CHANGED_REPO: ${repo_dir%/} -> $repo_name";',
      );
      expect(skillContent).toContain('cd "$workspace_root";');
      expect(skillContent).not.toContain(
        'for dir in */; do if [ -d "$dir/.git" ]; then',
      );
      expect(skillContent).not.toContain('for repo_dir in */ */*/; do');
    }
  });

  it('requires PR delivery skills to use the provided base branch for branch and PR creation', () => {
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');

    for (const skillContent of [createDraftPrSkill, createPrSkill]) {
      const branchStepIndex = skillContent.indexOf(
        '<title>Create the delivery branch from the provided base branch</title>',
      );
      const commitStepIndex = skillContent.indexOf(
        '<title>Commit any uncommitted work</title>',
      );

      expect(branchStepIndex).toBeGreaterThanOrEqual(0);
      expect(commitStepIndex).toBeGreaterThan(branchStepIndex);
      expect(skillContent).toContain(
        'before staging or committing pending work',
      );
      expect(skillContent).toContain(
        'git checkout -b <branch-name-for-this-repo> origin/<base-branch-for-this-repo>',
      );
      expect(skillContent).toContain(
        '`targetBranch: "<base-branch-for-this-repo>"`',
      );
      expect(skillContent).not.toContain('gh pr create');
      expect(skillContent).not.toContain('gh pr edit');
      expect(skillContent).toContain(
        'The delivery branch is created from the provided base/default branch',
      );
    }
  });

  it('requires PR delivery skills to switch to the delivery branch before staging or PR metadata work', () => {
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');

    for (const skillContent of [createDraftPrSkill, createPrSkill]) {
      const invariantIndex = skillContent.indexOf(
        '<delivery_branch_invariant>',
      );
      const workflowIndex = skillContent.indexOf('<workflow>');

      expect(invariantIndex).toBeGreaterThanOrEqual(0);
      expect(workflowIndex).toBeGreaterThan(invariantIndex);
      expect(skillContent).toContain(
        'Before staging files, writing `/tmp/pr-body.md`, committing, pushing, or calling `mcp__roomote__manage_source_control`, ensure each repository is on the delivery branch for this task',
      );
      expect(skillContent).toContain(
        'Do not perform delivery work directly from `main` or `master` unless the user explicitly selected that branch as the existing delivery branch for this task.',
      );
    }
  });

  it('requires PR delivery skills to pass the provided base branch explicitly when creating PRs', () => {
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');

    expect(createDraftPrSkill).toContain('<pull_request_base_invariant>');
    expect(createDraftPrSkill).toContain(
      "For every draft pull request, pass the provided base/default branch explicitly as `targetBranch` in the `mcp__roomote__manage_source_control` call; do not rely on the provider's repository default branch or the current local tracking branch to choose the PR base.",
    );
    expect(createDraftPrSkill).toContain(
      'Pass `targetBranch` on refresh calls too, so an existing draft pull request keeps its intended base relationship.',
    );
    expect(createDraftPrSkill).toContain(
      'Collect the pull request number and URL returned by each successful `mcp__roomote__manage_source_control` result, and treat that tool result as the live pull request reference instead of treating the final message as proof that the pull request exists.',
    );
    expect(createDraftPrSkill).toContain(
      'Every changed repository now has a corresponding created or refreshed draft pull request confirmed by a `mcp__roomote__manage_source_control` result',
    );

    expect(createPrSkill).toContain('<pull_request_base_invariant>');
    expect(createPrSkill).toContain(
      "For every pull request, pass the provided base/default branch explicitly as `targetBranch` in the `mcp__roomote__manage_source_control` call; do not rely on the provider's repository default branch or the current local tracking branch to choose the PR base.",
    );
    expect(createPrSkill).toContain(
      'Pass `targetBranch` on refresh calls too, so an existing pull request keeps its intended base relationship.',
    );
    expect(createPrSkill).toContain(
      'Collect the pull request number and URL returned by each successful `mcp__roomote__manage_source_control` result, and treat that tool result as the live pull request reference instead of treating the final message as proof that the pull request exists.',
    );
    expect(createPrSkill).toContain(
      'Every changed repository now has a corresponding created or refreshed pull request confirmed by a `mcp__roomote__manage_source_control` result',
    );
  });
});
