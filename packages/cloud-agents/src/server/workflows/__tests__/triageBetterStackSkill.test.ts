import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('triage-better-stack skill', () => {
  it('discovers capabilities without treating a filtered catalog as upstream availability', () => {
    const skillContent = fs.readFileSync(
      path.resolve(
        thisDirPath,
        '../skills/standard/triage-better-stack/SKILL.md',
      ),
      'utf8',
    );

    expect(skillContent).toContain('find_integration_tools');
    expect(skillContent).toContain('call_integration_tool');
    expect(skillContent).toContain(
      'Scope discovery to integration ID `betterstack`',
    );
    expect(skillContent).toContain('inspect returned schemas');
    expect(skillContent).toContain('Integration-scoped listings are bounded');
    expect(skillContent).toContain(
      'not that the integration is unconfigured or upstream lacks the tool',
    );
    expect(skillContent).toContain(
      'report the missing capability and lookup arguments',
    );
    expect(skillContent).toContain(
      'authentication or source-permission failures',
    );
    expect(skillContent).toContain('do not call a discovery gap an outage');
    expect(skillContent).toContain('do not fabricate the helper');
    expect(skillContent).toContain(
      "current source metadata's documented sample queries",
    );
    expect(skillContent).toContain('stop SQL rather than guessing');
    expect(skillContent).not.toContain('mcp__betterstack__');
    expect(skillContent).toContain('exact names returned by current discovery');
    expect(skillContent).toContain('not assumed vendor names');
    for (const name of ['sources', 'source', 'query', 'query_help']) {
      expect(skillContent).not.toContain(`\`${name}\``);
    }
  });

  it('routes ClickHouse queries from current source metadata instead of guessed identifiers', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/triage-better-stack/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'first list or inspect the accessible Better Stack sources',
    );
    expect(skillContent).toContain(
      'Route each query using the collection and cluster values returned by source metadata.',
    );
    expect(skillContent).toContain(
      'Do not derive collection names from the team ID, source ID, source URL',
    );
    expect(skillContent).toContain(
      'stop the SQL scan and report that routing blocker',
    );
  });
});
