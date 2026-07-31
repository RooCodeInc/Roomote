import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const standardSkillsDirPath = path.resolve(thisDirPath, '../skills/standard');

/**
 * Every standard skill that pushes on the agent's behalf. Skipping pre-push
 * removes whatever secret or policy scanner a repository hangs on that hook,
 * so the compensating guidance has to hold in all of them. The completeness
 * test below fails if a new skill starts pushing without joining this list.
 */
const DELIVERY_SKILLS = [
  'push',
  'create-pr',
  'create-draft-pr',
  'fix-pr',
  'environment-setup',
  'resolve-github-pr-merge-conflicts',
] as const;

/**
 * Skills that commit into an existing repository, so a pre-commit hook can
 * actually run. `environment-setup` is excluded on purpose: its only commit
 * bootstraps a repository with no commits, which has no hooks checked in.
 */
const COMMITTING_SKILLS = DELIVERY_SKILLS.filter(
  (skillName) => skillName !== 'environment-setup',
);

const PRE_COMMIT_CARVE_OUT =
  'Do not use `git commit --no-verify` unless no safer option remains.';

function readStandardSkill(skillName: string): string {
  return fs.readFileSync(
    path.join(standardSkillsDirPath, skillName, 'SKILL.md'),
    'utf8',
  );
}

/** `<action>` bodies in document order. */
function actions(skillContent: string): string[] {
  return Array.from(skillContent.matchAll(/<action>([\s\S]*?)<\/action>/g)).map(
    ([, body]) => body ?? '',
  );
}

function isPushAction(action: string): boolean {
  return /git push/.test(action);
}

function isSecretReviewAction(action: string): boolean {
  return /review the outgoing diff for secrets/i.test(action);
}

describe('standard delivery skills pre-push hook policy', () => {
  it('covers every standard skill that instructs an agent to push', () => {
    const pushingSkills = fs
      .readdirSync(standardSkillsDirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((skillName) =>
        actions(readStandardSkill(skillName)).some(isPushAction),
      )
      .sort();

    expect(pushingSkills).toEqual([...DELIVERY_SKILLS].sort());
  });

  it.each(DELIVERY_SKILLS)(
    'requires %s to push with --no-verify everywhere it spells out a push',
    (skillName) => {
      // Matches the whole line, so a fenced block or bare prose command is
      // caught too, not only single-line inline code spans.
      const pushCommands =
        readStandardSkill(skillName).match(/git push\b[^\n]*/g) ?? [];

      expect(pushCommands.length).toBeGreaterThan(0);

      for (const pushCommand of pushCommands) {
        expect(pushCommand).toContain('--no-verify');
        // `--no-verify` must not become cover for rewriting someone's branch.
        expect(pushCommand).not.toMatch(/--force(?!-with-lease)/);
      }
    },
  );

  it.each(DELIVERY_SKILLS)(
    'makes %s review the outgoing diff for secrets before it pushes',
    (skillName) => {
      const skillActions = actions(readStandardSkill(skillName));
      const secretReviewIndex = skillActions.findIndex(isSecretReviewAction);
      const firstPushIndex = skillActions.findIndex(isPushAction);

      expect(secretReviewIndex).toBeGreaterThanOrEqual(0);
      expect(firstPushIndex).toBeGreaterThanOrEqual(0);
      // Ordering is the whole point: a review the agent reaches after pushing
      // is not a gate. `toContain` on the file body would not catch that.
      expect(secretReviewIndex).toBeLessThan(firstPushIndex);
    },
  );

  it.each(DELIVERY_SKILLS)(
    'keeps the %s secret review mandatory rather than best-effort',
    (skillName) => {
      const secretReview = actions(readStandardSkill(skillName)).find(
        isSecretReviewAction,
      );

      expect(secretReview).toBeDefined();
      expect(secretReview).not.toMatch(
        /\b(skip|optional|when time|if time)\b/i,
      );
      // Finding a secret must block the push, not merely get mentioned.
      expect(secretReview).toMatch(/hard blocker|do not push/i);
    },
  );

  it.each(DELIVERY_SKILLS)(
    'stops %s from claiming someone else owns the gates that --no-verify skips',
    (skillName) => {
      const skillContent = readStandardSkill(skillName);

      // Roomote cannot verify that an arbitrary repository has a server-side
      // equivalent for the scanners its pre-push hook runs, so the skill must
      // not tell the agent that CI or branch protection covers them.
      // Case-sensitive `CI`: a case-insensitive match hits "suffiCIent".
      expect(skillContent).not.toMatch(
        /\b(CI|[Bb]ranch protection|[Ss]erver-side checks)\b[^.]{0,80}\bowns?\b/,
      );
      expect(skillContent).not.toMatch(/rely on CI\b/);
      expect(skillContent).toContain(
        'equivalent server-side coverage is not guaranteed',
      );
    },
  );

  it.each(DELIVERY_SKILLS)(
    'teaches %s that a rejection naming a secret is a finding, not an environment problem',
    (skillName) => {
      const skillContent = readStandardSkill(skillName);

      // Server-side push protection is the last secret gate once --no-verify
      // is unconditional, and it arrives as a `remote:` 403. Filing it under
      // "auth failure" would turn a caught leak into a credentials story.
      expect(skillContent).toContain(
        'is a real finding, not an environment problem',
      );
      expect(skillContent).toContain('GH013');
      expect(skillContent).toContain('never retry those with `--no-verify`');
      expect(skillContent).toContain(
        'never substitute a credentials story for a hook failure',
      );
    },
  );

  it.each(COMMITTING_SKILLS)(
    'keeps %s from generalising --no-verify from pushes to commits',
    (skillName) => {
      expect(readStandardSkill(skillName)).toContain(PRE_COMMIT_CARVE_OUT);
    },
  );
});
