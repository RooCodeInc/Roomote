import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readSkill(relativePath: string) {
  const thisFilePath = fileURLToPath(import.meta.url);
  const thisDirPath = path.dirname(thisFilePath);

  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('address-pr-feedback skill', () => {
  it('focuses the command on unresolved review threads and delegates fixer mechanics', () => {
    const standardSkill = readSkill(
      '../skills/standard/address-pr-feedback/SKILL.md',
    );

    expect(standardSkill).toContain(
      'If the `fix-pr` skill is not already loaded into your context, load it before deeper execution.',
    );
    expect(standardSkill).toContain(
      'build the issue inventory only from unresolved review threads',
    );
    expect(standardSkill).toContain(
      'For each unresolved thread, read the original review comment and all later replies before deciding what still needs to change.',
    );
    expect(standardSkill).toContain(
      'Post a reply on every thread you handled with `mcp__roomote__manage_source_control` `action: "reply_to_pull_request_comment"`',
    );
    expect(standardSkill).toContain(
      'Resolve only the review threads that are fully handled by the pushed fix, using `action: "resolve_pull_request_thread"` with `resolved: true`',
    );

    expect(standardSkill).toContain(
      'If the target PR is merge-conflicted, let `fix-pr` first delegate to `resolve-github-pr-merge-conflicts`, refresh live PR state, and only then continue the unresolved-thread fixes in the same fixer run.',
    );
  });
});
