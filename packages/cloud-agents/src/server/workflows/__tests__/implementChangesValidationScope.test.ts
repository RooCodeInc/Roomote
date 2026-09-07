import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('implement-changes validation scope guidance', () => {
  it('discourages low-signal class-assertion tests for narrow visual-only polish', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/resources/default-workflow.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('narrow visual-only polish changes');
    expect(skillContent).toContain(
      'the automated validation step may stop at the smallest relevant static checks',
    );
    expect(skillContent).toContain(
      'follow the separate visual-proof step defined earlier in this workflow',
    );
    expect(skillContent).toContain(
      'Do not add or expand automated tests whose main assertion is an exact Tailwind class',
    );
    expect(skillContent).toContain(
      'unless that detail is itself the contract or a reported regression',
    );
  });
});
