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

  it('requires confirmed draft PR delivery before a repository-changing run succeeds', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement and validate a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/create-draft-pr/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(harnessInstructions).toContain(
      '<default_mode>autonomous</default_mode>',
    );
    expect(harnessInstructions).toContain(
      'After validation and self-review, the next required action for repository-changing work is delegated delivery, not final reporting.',
    );
    expect(harnessInstructions).toContain(
      'the active `implement-changes` workflow stays responsible for the run until the required delivery result is known and must finish through the delegated `create-draft-pr` skill',
    );
    expect(skillContent).toContain(
      'Collect the pull request number and URL returned by each successful `mcp__roomote__manage_source_control` result, and treat that tool result as the live pull request reference instead of treating the final message as proof that the pull request exists.',
    );
    expect(skillContent).toContain(
      'Every changed repository now has a corresponding created or refreshed draft pull request confirmed by a `mcp__roomote__manage_source_control` result',
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
      'Generic requests such as “create PR”, “open PR”, or “deliver as a PR/MR” are not aliases for this path; they follow the task-level delivery policy, which defaults to draft delivery in Autonomous runs.',
    );
    expect(skillContent).toContain(
      'Generic “create PR” / “open PR” / “deliver as a PR/MR” requests also resolve here whenever the task-level delivery policy selects draft delivery.',
    );
  });
});
