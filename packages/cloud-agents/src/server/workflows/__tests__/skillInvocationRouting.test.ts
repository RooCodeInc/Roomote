import fs from 'node:fs';
import path from 'node:path';

import { isRecognizedInitialSkillInvocation } from '../skillInvocationRouting';

describe('packaged skill invocation routing', () => {
  const workflowsDir = path.resolve(import.meta.dirname, '..');
  const legacyImplementAlias = 'implement-repo' + '-change';
  const betaChoreSkillNames = [
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

  it('recognizes packaged beta chore skills regardless of repository', () => {
    for (const skillName of betaChoreSkillNames) {
      expect(
        isRecognizedInitialSkillInvocation({
          skillName,
        }),
      ).toBe(true);
    }
  });

  it('ships the zero Path C skill in the standard packaged skill catalog', () => {
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
    expect(skillContent).toContain('admin has enabled');
    expect(skillContent).not.toContain('bakes the CLI into the worker runtime');
  });

  it('ships beta chore skills in the standard packaged skill catalog', () => {
    for (const skillName of betaChoreSkillNames) {
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
