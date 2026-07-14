import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('Browser containment policy', () => {
  it('keeps the upstream agent-browser discovery stub while limiting it to explicit invocation or delegated browser work', () => {
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
      'the parent workflow must not load or directly use browser tooling',
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

    // Browser-level verification is delegated to the hidden proof-runner
    // subagent; the parent environment-setup workflow itself must never
    // issue browser commands or load browser tooling.
    expect(environmentSetupSkillContent).toContain(
      'Do not issue browser commands directly from this workflow; browser-level verification belongs to the delegated `proof-runner` subagent.',
    );
    expect(environmentSetupSkillContent).toContain(
      'do not issue browser commands from the parent workflow as a substitute',
    );
    expect(environmentSetupSkillContent).toContain(
      'never capture screenshots directly from the parent workflow',
    );
    expect(environmentSetupSkillContent).not.toContain('agent-browser');
  });
});
