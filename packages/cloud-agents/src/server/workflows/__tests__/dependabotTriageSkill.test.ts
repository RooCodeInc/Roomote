import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

describe('dependabot-triage skill', () => {
  it('reports to Slack and provider-neutral communication destinations', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/dependabot-triage/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'a destination in either `slack_channel_id` or `channel_id`',
    );
    expect(skillContent).toContain(
      'When either `slack_channel_id` or `channel_id` is present',
    );
    expect(skillContent).toContain('the configured communication conversation');
    expect(skillContent).not.toContain('If `slack_channel_id` is present');
  });
});
