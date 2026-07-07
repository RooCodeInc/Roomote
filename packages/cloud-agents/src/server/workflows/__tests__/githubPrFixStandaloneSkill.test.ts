import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('fix-pr skill', () => {
  it('treats merge-conflict resolution as a preflight that resumes the fixer flow', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/fix-pr/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'clear PR merge conflicts first when needed',
    );
    expect(skillContent).toContain(
      'delegate immediately to the canonical `resolve-github-pr-merge-conflicts` skill, then re-fetch the PR details, diff, and comments and resume the fixer workflow only from the refreshed mergeable PR state.',
    );
    expect(skillContent).toContain(
      'When the target PR was conflicted, merge conflicts were resolved through the canonical conflict-resolution skill before the main fixer flow proceeded.',
    );
    expect(skillContent).toContain(
      'resolve repo and PR -> use supplied snapshots when present -> fetch missing PR state including mergeability/fork metadata -> if conflicted, delegate to `resolve-github-pr-merge-conflicts` and then re-fetch live PR state -> fetch review and issue comments -> recover any missing linked-issue context -> checkout refreshed PR branch -> repository reading -> revalidate mutable state before side effects when needed',
    );
    expect(skillContent).toContain(
      'The PR was conflicted, but the delegated merge-conflict resolution step did not complete successfully, so the fixer cannot continue honestly.',
    );
    expect(skillContent).not.toContain(
      'gh pr checks [PR_NUMBER] --repo [owner]/[repo]',
    );
    expect(skillContent).not.toContain('required-check status');
  });
});
