import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('implement-changes parent review override guidance', () => {
  it('allows task-level workflows to narrow the parent review step without broadening all runs', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/resources/default-workflow.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('## 4. Validate and Review');
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
      'The judge checks the visual proof only: whether the images show the shipped change and whether source changed after capture began.',
    );
    expect(skillContent).toContain(
      'When the proof step kept no images, do not run the judge.',
    );
    expect(skillContent).toContain(
      'Once the required parent review step reaches a known state, update the todo list and continue to the branch/push/PR step.',
    );
    expect(skillContent).toContain(
      'implementation and the required parent review step are complete',
    );
  });
});
