import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('resolve-github-pr-merge-conflicts skill', () => {
  it('keeps an explicit machine-parseable final response contract', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/resolve-github-pr-merge-conflicts/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('<final_response_format>');
    expect(skillContent).toContain('Resolved merge conflicts in:');
    expect(skillContent).toContain("Decisions I'm not 100% sure:");
    expect(skillContent).toContain('Warnings:');
    expect(skillContent).toContain(
      'do not add extra prose before or after these sections',
    );
  });

  it('requires proof before keeping resurrected base-branch symbols', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/resolve-github-pr-merge-conflicts/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'reintroduces a symbol, config, or section absent from `origin/<baseRefName>`, verify that resurrection is intentional with `git grep` and `git log -S` against the base branch first.',
    );
    expect(skillContent).toContain('resurrection-proof checks');
  });
});
