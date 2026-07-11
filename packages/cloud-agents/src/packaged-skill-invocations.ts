export const PACKAGED_BETA_CHORE_SKILL_INVOCATIONS = [
  'code-quality-auditor',
  'fix-sentry-error',
  'refactor-code',
  'security-auditor',
  'triage-better-stack',
  'triage-sentry',
] as const;

const CORE_PACKAGED_SKILL_INVOCATIONS = [
  'address-pr-feedback',
  'agent-browser',
  'capture-visual-proof',
  'ci-failure-triage',
  'create-draft-pr',
  'create-pr',
  'debug-reported-bug',
  'dependabot-triage',
  'environment-setup',
  'explain-repo-code',
  'fix-pr',
  'implement-repo-change',
  'implement-changes',
  'merge-resolution-review',
  'merge-resolver',
  'plan-repo-implementation',
  'push',
  'push-branch',
  'resolve-github-pr-merge-conflicts',
  'review-and-fix',
  'review-code',
  'sentry-triage',
  'simplify',
  'update-dependencies',
  'zero',
] as const;

export const PACKAGED_SKILL_INVOCATIONS = [
  ...CORE_PACKAGED_SKILL_INVOCATIONS,
  ...PACKAGED_BETA_CHORE_SKILL_INVOCATIONS,
] as const;

export const PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS = [
  ...PACKAGED_SKILL_INVOCATIONS,
] as const;
