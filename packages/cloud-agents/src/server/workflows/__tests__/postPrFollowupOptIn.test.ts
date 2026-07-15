import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readSkill(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

describe('post-PR follow-up opt-in in delivery skills', () => {
  it('asks once after successful PR delivery with a lightweight conversational question', () => {
    const createPrSkill = readSkill('../skills/standard/create-pr/SKILL.md');
    const createDraftPrSkill = readSkill(
      '../skills/standard/create-draft-pr/SKILL.md',
    );

    for (const skillContent of [createPrSkill, createDraftPrSkill]) {
      expect(skillContent).toContain('Offer automatic CI and review follow-up');
      expect(skillContent).toContain(
        'ask once in plain language whether they want the agent to automatically address CI failures or review feedback on the opened pull request(s)',
      );
      expect(skillContent).toContain(
        'Keep it short—one brief question, not a form or multi-part questionnaire.',
      );
      expect(skillContent).toContain(
        'Do not start that follow-up work until they opt in.',
      );
      expect(skillContent).toContain('Run this step only when at least one');
      expect(skillContent).toContain(
        'Skip it for no-op or fully blocked deliveries.',
      );
      expect(skillContent).toContain(
        'Do not use `request_user_input` for this ask. A single casual Yes/No is enough; structured input is too heavy for this follow-up offer.',
      );
      expect(skillContent).toContain(
        'Prefer a lightweight conversational ask in the normal closeout channel',
      );
      expect(skillContent).toContain(
        'address them using the existing PR-fixer and CI-repair paths (`fix-pr`, `address-pr-feedback`, or equivalent CI failure investigation) instead of opening a new PR.',
      );
      expect(skillContent).toContain(
        'If the user declines, or does not answer after the ask is posted, end the delivery cleanly without watching CI or polluting the PR with unsolicited fixes.',
      );
      expect(skillContent).toContain('post_delivery_followup_opt_in');
      expect(skillContent).toContain(
        'only began that follow-up after explicit opt-in',
      );
      expect(skillContent).not.toMatch(
        /Prefer a single structured `request_user_input` question/,
      );
    }
  });
});
