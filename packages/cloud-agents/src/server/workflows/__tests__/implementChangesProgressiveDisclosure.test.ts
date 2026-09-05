import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const standardSkills = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../skills/standard',
);
const root = fs.readFileSync(
  path.join(standardSkills, 'implement-changes/SKILL.md'),
  'utf8',
);

describe('implement-changes progressive disclosure', () => {
  it('loads the linked default resource only for parent execution, not inheritance', () => {
    const resource = root.match(
      /\[resources\/default-workflow\.md\]\(([^)]+)\)/,
    )?.[1];
    expect(resource).toBe('resources/default-workflow.md');
    const workflow = fs.readFileSync(
      path.join(standardSkills, 'implement-changes', resource!),
      'utf8',
    );

    expect(root).toContain('id="default-path"');
    expect(root).toContain('without an explicit child-path selection');
    expect(root).toContain('before deeper execution');
    expect(root).toContain(
      'Do not read the default-workflow resource for child inheritance unless the caller explicitly instructed the parent default path to run first.',
    );
    expect(root).not.toContain('## 1. Ground and Plan');
    expect(workflow).toContain('## 1. Ground and Plan');
    expect(workflow).toContain('## 6. Report the Actual Outcome');
    expect(workflow).toContain("Apply the root's `core-contract` throughout.");
  });

  it.each([
    ['create-pr', 'create-pr'],
    ['create-draft-pr', 'create-draft-pr'],
    ['push-branch', 'push'],
    ['fix-github-pr-feedback', 'fix-pr'],
    ['resolve-github-pr-merge-conflicts', 'resolve-github-pr-merge-conflicts'],
  ])(
    'keeps %s discoverable without loading the default workflow',
    (childPath, skill) => {
      expect(root).toContain('id="core-contract"');
      expect(root).toContain('id="child-skill-registry"');
      expect(root).toContain(
        `<appendix name="${childPath}" id="appendix-${childPath}">`,
      );
      expect(root).toContain(`Load \`${skill}\``);
      const child = fs.readFileSync(
        path.join(standardSkills, skill, 'SKILL.md'),
        'utf8',
      );
      expect(child).toContain('inherit only the `core-contract` section');
      expect(child).toContain(
        "Do not execute `implement-changes`'s default workflow from this child skill unless the caller explicitly instructed the parent default path to run first.",
      );
    },
  );

  it('keeps shared authorization, truthfulness, and unresolved obligations in the root', () => {
    expect(root).toContain(
      'Do not create a pull request unless that policy allows it.',
    );
    expect(root).toContain(
      'Do not claim branch, push, PR, validation, or proof steps completed unless they actually happened.',
    );
    expect(root).toContain(
      'Carry unresolved parent proof, delivery, blocker, and input-needed obligations across handoffs until resolved',
    );
    expect(root).toContain(
      "For standalone child invocation, follow that child's own workflow instead; do not force the default sequence.",
    );
  });
});
