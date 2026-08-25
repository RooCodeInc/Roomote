export const PACKAGED_SKILL_CATALOG = {
  'address-pr-feedback': { fastMode: 'task' },
  'agent-browser': { fastMode: 'task' },
  'capture-visual-proof': { fastMode: 'task' },
  'ci-failure-triage': { fastMode: 'task' },
  'code-quality-auditor': { fastMode: 'task' },
  'codeql-triage': { fastMode: 'task' },
  'create-draft-pr': { fastMode: 'task' },
  'create-pr': { fastMode: 'task' },
  'debug-reported-bug': { fastMode: 'task' },
  'dependabot-triage': { fastMode: 'task' },
  doctor: { fastMode: 'task' },
  'environment-setup': { fastMode: 'task' },
  'explain-repo-code': { fastMode: 'task' },
  'explore-and-act': { fastMode: 'direct' },
  'feature-demo': { fastMode: 'task' },
  'fix-pr': { fastMode: 'task' },
  'fix-sentry-error': { fastMode: 'task' },
  'github-management': { fastMode: 'task' },
  'implement-changes': { fastMode: 'task' },
  'implement-repo-change': { fastMode: 'task' },
  'issue-fixer': { fastMode: 'task' },
  'plan-repo-implementation': { fastMode: 'task' },
  push: { fastMode: 'task' },
  'refactor-code': { fastMode: 'task' },
  'resolve-github-pr-merge-conflicts': { fastMode: 'task' },
  'review-and-fix': { fastMode: 'task' },
  'review-code': { fastMode: 'task' },
  'security-auditor': { fastMode: 'task' },
  'security-best-practices': { fastMode: 'task' },
  'security-review': { fastMode: 'task' },
  'sentry-triage': { fastMode: 'task' },
  simplify: { fastMode: 'task' },
  'triage-better-stack': { fastMode: 'task' },
  'triage-sentry': { fastMode: 'task' },
  'update-dependencies': { fastMode: 'task' },
  zero: { fastMode: 'task' },
} as const satisfies Record<string, { fastMode: 'direct' | 'task' }>;

export type PackagedSkillName = keyof typeof PACKAGED_SKILL_CATALOG;

const packagedSkillNames = Object.keys(
  PACKAGED_SKILL_CATALOG,
) as PackagedSkillName[];

function selectFastSkills(
  fastMode: 'direct' | 'task',
): [PackagedSkillName, ...PackagedSkillName[]] {
  const [first, ...rest] = packagedSkillNames.filter(
    (name) => PACKAGED_SKILL_CATALOG[name].fastMode === fastMode,
  );
  if (!first)
    throw new Error(`Packaged skill catalog has no ${fastMode} skills.`);
  return [first, ...rest];
}

export const FAST_DIRECT_PACKAGED_SKILL_NAMES = selectFastSkills('direct');

export const FAST_TASK_PACKAGED_SKILL_NAMES = selectFastSkills('task');
