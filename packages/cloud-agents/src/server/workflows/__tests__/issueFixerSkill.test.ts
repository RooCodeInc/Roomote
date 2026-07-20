import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDirPath = path.dirname(fileURLToPath(import.meta.url));

function readIssueFixerSkill(): string {
  return fs.readFileSync(
    path.resolve(thisDirPath, '../skills/standard/issue-fixer/SKILL.md'),
    'utf8',
  );
}

describe('issue-fixer skill', () => {
  it('uses provider-neutral issue operations with server-side credentials', () => {
    const skill = readIssueFixerSkill();

    expect(skill).toContain('action `get_issue`');
    expect(skill).toContain('action `list_issue_comments`');
    expect(skill).toContain('action `create_issue_comment`');
    expect(skill).toContain('Provider credentials remain server-side');
    expect(skill).not.toContain('GITLAB_TOKEN');
    expect(skill).not.toContain('GITEA_TOKEN');
    expect(skill).not.toContain('Post with provider-native tooling');
  });
});
