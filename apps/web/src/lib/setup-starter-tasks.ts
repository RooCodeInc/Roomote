import {
  SETUP_STARTER_TASK_IDS,
  type SetupStarterTaskId,
} from '@roomote/types';

/**
 * Fixed catalog of starter tasks offered on the final /setup step.
 *
 * Every entry launches a direct standard task on the web surface, so none of
 * them require a communication provider and none of them create custom
 * automations. The prompts are deliberately scoped to one concern each and ask
 * the agent to focus on the most impactful repository, because the launch
 * workspace may span every connected repository.
 */

export { SETUP_STARTER_TASK_IDS, type SetupStarterTaskId };

type SetupStarterTask = {
  id: SetupStarterTaskId;
  title: string;
  description: string;
  prompt: string;
};

export const SETUP_STARTER_TASKS: readonly SetupStarterTask[] = [
  {
    id: 'speed-up-ci',
    title: 'Speed up CI',
    description: 'Save your precious time by finding ways to speed up CI.',
    prompt: `Speed up our continuous integration.

Review the CI configuration in the most impactful repository in this workspace: workflows, caching, test parallelism, and dependency installation. Identify the biggest sources of wasted time, then implement the safest high-impact improvements (for example caching dependencies, splitting or parallelizing slow jobs, or removing redundant steps) and open a pull request. Summarize the expected time savings and call out any riskier optimizations you deliberately left for follow-up.`,
  },
  {
    id: 'security-scan',
    title: 'Security scan',
    description:
      'Catch vulnerabilities and secure-by-default gaps before they become problems.',
    prompt: `Run a security review of the most impactful repository in this workspace.

Look for concrete vulnerabilities and secure-by-default gaps: injection risks, missing authentication or authorization checks, unsafe handling of secrets or user input, and risky dependency usage. Prioritize findings by severity and confidence. When a safe, targeted fix exists for the highest-confidence issues, implement it and open a pull request; report the remaining findings with file references so the team can follow up.`,
  },
  {
    id: 'fix-test-flakes',
    title: 'Fix test flakes',
    description:
      'Stop flaky tests from wasting your time by making them reliable.',
    prompt: `Find and fix flaky tests.

Inspect the test suites and recent CI behavior in the most impactful repository in this workspace for tests that fail intermittently. Timing assumptions, shared state, unawaited async work, and test-order dependence are common causes. Reproduce the flakiest ones, fix the root causes so the tests are deterministic, and open a pull request. List any flaky tests you found but did not fix, with what you learned about each.`,
  },
  {
    id: 'update-dependencies',
    title: 'Update dependencies',
    description:
      'Keep your codebase fresh with safe dependency upgrades, and flag the risky ones.',
    prompt: `Update the dependencies of the most impactful repository in this workspace.

Check for outdated or vulnerable dependencies, apply the safe upgrades (patch and minor versions, plus security fixes), and validate the result with the repository's own install, build, and test tooling before opening a pull request. Do not attempt risky major upgrades; list them separately with a short note on what each one would involve.`,
  },
];

const SETUP_STARTER_TASKS_BY_ID = new Map<SetupStarterTaskId, SetupStarterTask>(
  SETUP_STARTER_TASKS.map((starterTask) => [starterTask.id, starterTask]),
);

export function getSetupStarterTask(id: SetupStarterTaskId): SetupStarterTask {
  const starterTask = SETUP_STARTER_TASKS_BY_ID.get(id);

  if (!starterTask) {
    throw new Error(`Unknown starter task: ${id}`);
  }

  return starterTask;
}
