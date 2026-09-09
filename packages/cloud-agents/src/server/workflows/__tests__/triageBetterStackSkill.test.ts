import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('triage-better-stack skill', () => {
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
