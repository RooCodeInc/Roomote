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
      'when either `slack_channel_id` or `channel_id` is present',
    );
    expect(skillContent).toContain('the configured communication conversation');
    expect(skillContent).not.toContain('If `slack_channel_id` is present');
  });

  it('stays silent only for conclusive zero-alert no-op scans', () => {
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/dependabot-triage/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'the total open alert count is 0, and no remediation work item was submitted or started',
    );
    expect(skillContent).toContain('do not call `send_chat_reply`');
    expect(skillContent).toContain(
      'GitHub access blockers still require a communication report',
    );
    expect(skillContent).toContain(
      'Otherwise, when either `slack_channel_id` or `channel_id` is present',
    );
  });
});
