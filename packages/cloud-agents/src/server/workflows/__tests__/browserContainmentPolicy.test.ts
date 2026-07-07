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

  it('documents that browser automation stays in proof children while the standard catalog carries only a hidden discovery stub', () => {
    const agentContextPath = path.resolve(
      thisDirPath,
      '../../../../../../.agent-guidance/architecture/agent-context.md',
    );
    const environmentSetupSkillPath = path.resolve(
      thisDirPath,
      '../skills/standard/environment-setup/SKILL.md',
    );
    const workflowContractsPath = path.resolve(
      thisDirPath,
      '../../../../../../.agent-guidance/architecture/workflow-contracts.md',
    );
    const workflowSystemPath = path.resolve(
      thisDirPath,
      '../../../../../../.agent-guidance/architecture/workflow-system.md',
    );
    const agentContextContent = fs.readFileSync(agentContextPath, 'utf8');
    const workflowContractsContent = fs.readFileSync(
      workflowContractsPath,
      'utf8',
    );
    const workflowSystemContent = fs.readFileSync(workflowSystemPath, 'utf8');
    const environmentSetupSkillContent = fs.readFileSync(
      environmentSetupSkillPath,
      'utf8',
    );

    expect(agentContextContent).toContain(
      'Another is the hidden [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) discovery stub.',
    );
    expect(agentContextContent).toContain(
      'Roomote keeps that checked-in stub aligned with the upstream `vercel-labs/agent-browser` discovery file rather than maintaining a separate local browser-command summary.',
    );
    expect(agentContextContent).toContain(
      'The stub is still not part of the three-workflow StandardTask bootstrap for ordinary natural-language requests, so browser automation stays contained inside delegated proof children unless a workflow explicitly asks for browser work.',
    );
    expect(agentContextContent).toContain(
      'Direct `/agent-browser` or `$agent-browser` invocation is still honored so the packaged stub can hand the agent back to the installed CLI guidance when the user asks for that browser entrypoint explicitly.',
    );
    expect(workflowContractsContent).toContain(
      'the standard catalog now carries a hidden [`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) discovery stub that tells the agent to load CLI-served guidance first.',
    );
    expect(workflowContractsContent).toContain(
      'That checked-in stub mirrors the upstream `vercel-labs/agent-browser` discovery file so Roomote does not drift into a second local browser-command guide.',
    );
    expect(workflowContractsContent).toContain(
      '[`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md) is a hidden discovery stub rather than a routed workflow.',
    );
    expect(workflowContractsContent).toContain(
      'if the user explicitly invokes `/agent-browser` or `$agent-browser`, `standardTask()` should hand off to the stub directly so it can redirect the agent into CLI-served browser guidance',
    );
    expect(workflowSystemContent).toContain(
      '[`agent-browser`](../../packages/cloud-agents/src/server/workflows/skills/standard/agent-browser/SKILL.md)',
    );
    expect(workflowSystemContent).toContain(
      'Not part of ordinary `standardTask()` initial routing or Task Tools; mirrors the upstream `vercel-labs/agent-browser` discovery stub and tells the agent to load CLI-served `agent-browser skills get core` guidance first, while still honoring explicit `/agent-browser` or `$agent-browser` entry',
    );
    expect(environmentSetupSkillContent).toContain(
      'Do not use direct browser automation from `environment-setup`.',
    );
    expect(environmentSetupSkillContent).not.toContain('agent-browser');
  });
});
