import fs from 'node:fs';
import path from 'node:path';

import { isRecognizedInitialSkillInvocation } from '../skillInvocationRouting';

describe('packaged skill invocation routing', () => {
  const workflowsDir = path.resolve(import.meta.dirname, '..');
  const legacyImplementAlias = 'implement-repo' + '-change';
  const automationSkillNames = [
    'code-quality-auditor',
    'fix-sentry-error',
    'refactor-code',
    'triage-better-stack',
    'triage-sentry',
    'update-dependencies',
  ] as const;
  const securitySkillNames = [
    'security-auditor',
    'security-best-practices',
    'security-review',
  ] as const;

  const readPackagedSkill = (skillName: string) =>
    fs.readFileSync(
      path.join(workflowsDir, 'skills', 'standard', skillName, 'SKILL.md'),
      'utf8',
    );

  const listBacktickMarkdownReferences = (
    content: string,
    directoryNames: string[],
  ) => {
    const directoryPattern = directoryNames
      .map((directoryName) =>
        directoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('|');
    const referencePattern = new RegExp(
      '`((?:' + directoryPattern + ')/[^`]+\\.md)`',
      'g',
    );

    return Array.from(content.matchAll(referencePattern)).map((match) => {
      const reference = match[1];

      if (reference === undefined) {
        throw new Error('Expected markdown reference capture group');
      }

      return reference;
    });
  };

  it('keeps implement workflow aliases recognized for initial routing', () => {
    expect(
      isRecognizedInitialSkillInvocation({
        skillName: 'implement-changes',
      }),
    ).toBe(true);

    expect(
      isRecognizedInitialSkillInvocation({
        skillName: legacyImplementAlias,
      }),
    ).toBe(true);
  });

  it('ships the general exploration and action workflow for initial routing', () => {
    expect(
      isRecognizedInitialSkillInvocation({
        skillName: 'explore-and-act',
      }),
    ).toBe(true);

    const generalSkill = readPackagedSkill('explore-and-act');

    expect(generalSkill).toContain('name: explore-and-act');
    expect(generalSkill).toContain(
      'Perform an external side effect only when the user named the exact action and target',
    );
    expect(generalSkill).toContain(
      'those narrower rules override this general workflow',
    );
    expect(generalSkill).toContain(
      'Do not assume repository inspection is relevant',
    );
    expect(generalSkill).not.toContain('read the applicable repo-local');
  });

  it('recognizes packaged automation skills regardless of repository', () => {
    for (const skillName of automationSkillNames) {
      expect(
        isRecognizedInitialSkillInvocation({
          skillName,
        }),
      ).toBe(true);
    }
  });

  it('ships the zero skill in the standard packaged skill catalog', () => {
    const skillPath = path.join(
      workflowsDir,
      'skills',
      'standard',
      'zero',
      'SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(skillContent).toContain('name: zero');
    expect(skillContent).toContain('hidden: true');
    expect(skillContent).toContain('zero search');
    expect(skillContent).toContain('deployment operator has enabled Zero');
    expect(skillContent).not.toContain('bakes the CLI into the worker runtime');
    expect(skillContent).toContain('org-scoped');
  });

  it('ships automation skills in the standard packaged skill catalog', () => {
    for (const skillName of automationSkillNames) {
      expect(
        fs.existsSync(
          path.join(workflowsDir, 'skills', 'standard', skillName, 'SKILL.md'),
        ),
      ).toBe(true);
    }
  });

  it('ships security audit skills in the standard packaged skill catalog', () => {
    for (const skillName of securitySkillNames) {
      expect(
        fs.existsSync(
          path.join(workflowsDir, 'skills', 'standard', skillName, 'SKILL.md'),
        ),
      ).toBe(true);
    }
  });

  it('keeps security-review language and infrastructure references packaged', () => {
    const securityReviewSkill = readPackagedSkill('security-review');
    const guideReferences = listBacktickMarkdownReferences(
      securityReviewSkill,
      ['languages', 'infrastructure'],
    );

    expect(guideReferences.length).toBeGreaterThan(0);

    for (const guideReference of guideReferences) {
      expect(
        fs.existsSync(
          path.join(
            workflowsDir,
            'skills',
            'standard',
            'security-review',
            guideReference,
          ),
        ),
      ).toBe(true);
    }
  });

  it('keeps security-best-practices Go guidance discoverable by language prefix', () => {
    const securityBestPracticesDir = path.join(
      workflowsDir,
      'skills',
      'standard',
      'security-best-practices',
    );

    expect(
      fs.existsSync(
        path.join(
          securityBestPracticesDir,
          'references',
          'go-general-backend-security.md',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          securityBestPracticesDir,
          'references',
          'golang-general-backend-security.md',
        ),
      ),
    ).toBe(false);
  });
});
