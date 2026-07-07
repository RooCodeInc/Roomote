import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('implement-changes parent review override guidance', () => {
  it('allows task-level workflows to narrow the parent review step without broadening all runs', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      '<title>Run the required parent review step</title>',
    );
    expect(skillContent).toContain(
      'By default, run a brief self-review over the task diff before branch/push/PR actions, focused on obvious request-satisfaction gaps, diff stability, accidental scope creep, and other cheap author-side catches.',
    );
    expect(skillContent).toContain(
      'When task-level workflow instructions explicitly narrow or replace the parent review step, obey that narrower override instead of duplicating another review pass.',
    );
    expect(skillContent).toContain(
      'if the workflow says the parent step is only a brief author sanity check before a child review loop',
    );
    expect(skillContent).toContain(
      'Ask it specifically to compare plan versus built result, not to repeat generic code review',
    );
    expect(skillContent).toContain(
      'keep any repo reads minimal and targeted instead of doing open-ended exploration',
    );
    expect(skillContent).toContain(
      'Once the required parent review step reaches a known state, update the todo list and continue to the branch/push/PR step.',
    );
    expect(skillContent).toContain(
      'implementation and the required parent review step are complete',
    );
  });
});
