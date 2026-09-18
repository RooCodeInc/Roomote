import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('Browser containment policy', () => {
  it('keeps the upstream agent-browser discovery stub while limiting it to explicit invocation or the capture-visual-proof step', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/agent-browser/SKILL.md',
    );
    const packagedSkillInvocationsPath = path.resolve(
      thisDirPath,
      '../../../packaged-skill-invocations.ts',
    );
    const standardTaskPath = path.resolve(thisDirPath, '../standardTask.ts');
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const packagedSkillInvocationsContent = fs.readFileSync(
      packagedSkillInvocationsPath,
      'utf8',
    );
    const standardTaskContent = fs.readFileSync(standardTaskPath, 'utf8');

    expect(fs.existsSync(skillPath)).toBe(true);
    expect(skillContent).toContain('hidden: true');
    expect(skillContent).toContain(
      'allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)',
    );
    expect(skillContent).toContain(
      'This file is a discovery stub, not the usage guide.',
    );
    expect(skillContent).toContain('agent-browser skills get core');
    expect(skillContent).toContain('agent-browser skills get core --full');
    expect(skillContent).toContain('agent-browser skills get electron');
    expect(packagedSkillInvocationsContent).toContain("'agent-browser'");
    expect(standardTaskContent).toContain(
      'Browser capture belongs inside that step and follows its `agent-browser` rules.',
    );
  });

  it('keeps environment-setup free of direct browser automation', () => {
    const environmentSetupSkillPath = path.resolve(
      thisDirPath,
      '../skills/standard/environment-setup/SKILL.md',
    );
    const environmentSetupSkillContent = fs.readFileSync(
      environmentSetupSkillPath,
      'utf8',
    );

    expect(environmentSetupSkillContent).toContain(
      'Do not use direct browser automation from `environment-setup`.',
    );
    expect(environmentSetupSkillContent).not.toContain('agent-browser');
  });
});
