import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { standardTask } from '../standardTask';

describe('Standard Task draft delivery policy', () => {
  it('clarifies that generic PR/MR requests stay on draft delivery in Autonomous runs', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'must finish through the delegated `create-draft-pr` skill',
    );
    expect(harnessInstructions).toContain(
      'A request to create, open, or deliver a pull request or merge request is satisfied by draft delivery and is not such an instruction; switch to `create-pr` only when the user explicitly asks for a ready-for-review or non-draft pull request, or explicitly invokes the `$create-pr` command.',
    );
    expect(harnessInstructions).toContain(
      'New pull requests for this run will be opened in the draft state per the deployment PR delivery setting, and updates preserve the existing state.',
    );
  });

  it('keeps ready-for-review delivery when the configured action is create', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement behavior change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      prAction: 'create',
    });

    expect(harnessInstructions).toContain(
      'must finish through the delegated `create-pr` skill',
    );
    expect(harnessInstructions).toContain(
      'New pull requests for this run will be opened in the ready-for-review state per the deployment PR delivery setting, and updates preserve the existing state.',
    );
    expect(harnessInstructions).not.toContain(
      'A request to create, open, or deliver a pull request or merge request is satisfied by draft delivery',
    );
  });

  it('does not treat generic create/open PR phrasing as a ready-for-review alias in implement-changes', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).not.toContain(
      '<alias path="create-pr">Aliases include “create PR”',
    );
    expect(skillContent).toContain(
      'Generic requests such as "create PR", "open PR", or "deliver as a PR/MR" follow task-level delivery policy, which defaults to draft delivery in Autonomous runs; they do not select this ready path.',
    );
    expect(skillContent).toContain(
      'generic create/open/deliver PR/MR requests also select this path when task-level policy selects draft delivery.',
    );
  });
});
