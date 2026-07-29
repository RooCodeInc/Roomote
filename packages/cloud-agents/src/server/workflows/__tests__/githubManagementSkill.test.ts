import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDirPath = path.dirname(fileURLToPath(import.meta.url));

function readGitHubManagementSkill(): string {
  return fs.readFileSync(
    path.resolve(thisDirPath, '../skills/standard/github-management/SKILL.md'),
    'utf8',
  );
}

describe('github-management skill', () => {
  it('requires confirmation and read-back for GitHub mutations', () => {
    const skill = readGitHubManagementSkill();

    expect(skill).toContain('use `request_user_input`');
    expect(skill).toContain('After a write, read back');
    expect(skill).toContain('separate explicit confirmation');
  });

  it('uses the scoped GitHub CLI contract and gates native saved views', () => {
    const skill = readGitHubManagementSkill();

    expect(skill).toContain('use `gh api` only');
    expect(skill).toContain('`gh api graphql`');
    expect(skill).toContain('Native GitHub saved views are not supported');
    expect(skill).toContain('do not inject a linked user');
  });
});
