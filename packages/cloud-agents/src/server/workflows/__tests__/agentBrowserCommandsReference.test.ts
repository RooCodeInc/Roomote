import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('Agent browser command reference', () => {
  it('mirrors the upstream agent-browser discovery stub rather than a local summary', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/agent-browser/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain('hidden: true');
    expect(skillContent).toContain(
      'allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)',
    );
    expect(skillContent).toContain(
      'Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with',
    );
    expect(skillContent).toContain(
      'Install: `npm i -g agent-browser && agent-browser install`',
    );
    expect(skillContent).toContain(
      'This file is a discovery stub, not the usage guide.',
    );
    expect(skillContent).toContain('agent-browser skills get core');
    expect(skillContent).toContain('agent-browser skills get core --full');
    expect(skillContent).toContain(
      'The CLI serves skill content that always matches the installed version',
    );
    expect(skillContent).toContain('agent-browser skills get electron');
    expect(skillContent).toContain('agent-browser skills get agentcore');
    expect(skillContent).toContain(
      'Fast native Rust CLI, not a Node.js wrapper',
    );
    expect(skillContent).toContain('## Observability Dashboard');
    expect(skillContent).toContain('https://dashboard.agent-browser.localhost');
  });
});
