import { standardTask } from '../standardTask';
import { PACKAGED_BETA_CHORE_SKILL_INVOCATIONS } from '../skillInvocationRouting';
import { buildStructuredTaskRequest } from '../utils';

describe('Standard Task explicit invocation routing', () => {
  it('skips the three-workflow initial routing step when the request already starts with a packaged-skill invocation', () => {
    const { prompt, harnessInstructions } = standardTask({
      description:
        '$review-code\n\n<active_appendix_path>review-github-pr</active_appendix_path>',
      repo: 'Roomote/example-app',
      cloudJobUrl: 'https://example.com/task/123',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$review-code\n<request>')).toBe(true);
    expect(harnessInstructions).toContain(
      "If the user's request begins with an explicit Roomote-shipped packaged-skill invocation, treat that invocation as the authoritative initial skill selection and execute that exact skill first.",
    );
    expect(harnessInstructions).toContain(
      'skip the three-workflow initial routing step entirely',
    );
    expect(harnessInstructions).toContain(
      'Roomote-shipped packaged skills take precedence for ordinary natural-language first-hop routing, even when repo-local skills are discoverable in the current workspace.',
    );
    expect(harnessInstructions).toContain(
      'If the user explicitly invokes a discoverable repo-local skill by name, let the active harness resolve that invocation instead of forcing it back through the three first-hop workflows.',
    );
  });

  it('requires ordinary natural-language requests to enter the selected packaged workflow before repository work', () => {
    const { harnessInstructions } = standardTask({
      description: 'Fix one low-risk maintainer rough edge and validate it',
      repo: 'Roomote/example-app',
      cloudJobUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'For ordinary natural-language requests, choosing the initial workflow means entering and executing that packaged skill before repository exploration, file edits, validation, or final reporting.',
    );
    expect(harnessInstructions).toContain(
      'Do not satisfy an implementation request by freehanding repository commands from this wrapper while the selected packaged workflow remains unloaded.',
    );
    expect(harnessInstructions).toContain(
      'The initial core skill choice is internal plumbing. Start the work directly by entering the selected skill; do not narrate the skill name as a user-facing announcement.',
    );
  });

  it('uses implementation straightforwardness as the ambiguous-routing tiebreaker and otherwise defaults to plan', () => {
    const { harnessInstructions } = standardTask({
      description: 'Maybe adjust the agent routing behavior if needed',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'When the request is mixed or ambiguous, use implementation straightforwardness as the tiebreaker:',
    );
    expect(harnessInstructions).toContain(
      'route to `implement-changes` when the likely implementation path is narrow, conventional, and low-decision',
    );
    expect(harnessInstructions).toContain(
      'If the request remains ambiguous after that straightforwardness check, default the initial route to `plan-repo-implementation`.',
    );
  });

  it('keeps non-packaged slash commands inside the request wrapper', () => {
    const { prompt } = standardTask({
      description: '/compact\n\nSummarize the current context.',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('<request>/compact')).toBe(true);
  });

  it('escapes closing request tags inside structured task-context values', () => {
    const description = buildStructuredTaskRequest({
      command: '$review-code',
      activeAppendixPath: 'review-github-pr',
      taskContext: {
        repository: 'Roomote/example-app',
        pull_request_details: 'Body before </request> body after',
      },
    });

    const { prompt } = standardTask({
      description,
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt).toContain('&lt;/request&gt;');
    expect(prompt.match(/<\/request>/g)).toHaveLength(1);
  });

  it('keeps packaged-skill invocations ahead of the request wrapper', () => {
    const { prompt } = standardTask({
      description:
        '$fix-pr\n\n<active_appendix_path>fix-github-pr-feedback</active_appendix_path>',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$fix-pr\n<request>')).toBe(true);
  });

  it('treats explicit agent-browser invocations as packaged-skill entry', () => {
    const { prompt } = standardTask({
      description: '$agent-browser\n\nOpen the preview and inspect the page.',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$agent-browser\n<request>')).toBe(true);
  });

  it('treats productized Sentry triage invocations as packaged-skill entry in customer repos', () => {
    const { prompt } = standardTask({
      description:
        '$sentry-triage\n\n<task_context><source>background-automation</source></task_context>',
      repo: 'acme/widgets',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$sentry-triage\n<request>')).toBe(true);
  });

  it('treats productized Dependabot triage invocations as packaged-skill entry in customer repos', () => {
    const { prompt } = standardTask({
      description:
        '$dependabot-triage\n\n<task_context><source>background-automation</source></task_context>',
      repo: 'acme/widgets',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$dependabot-triage\n<request>')).toBe(true);
  });

  it('treats dependency update follow-up invocations as packaged-skill entry in customer repos', () => {
    const { prompt } = standardTask({
      description:
        '$update-dependencies\n\n<task_context><source>dependabot_triage_slack_reaction</source></task_context>',
      repo: 'acme/widgets',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$update-dependencies\n<request>')).toBe(true);
  });

  // Independent catalog of packaged beta chore skills that should route as
  // authoritative entry points for every repo. Hardcoded here on purpose so a
  // future edit that drops a skill from the production list also has to
  // delete its line below; otherwise the equality assertion below catches
  // the drift instead of letting both lists shrink in lockstep.
  const EXPECTED_BETA_CHORE_SKILLS = [
    'code-quality-auditor',
    'fix-sentry-error',
    'refactor-code',
    'security-auditor',
    'triage-better-stack',
    'triage-sentry',
  ] as const;

  it('exposes the packaged beta chore skill catalog as authoritative entry points', () => {
    expect([...PACKAGED_BETA_CHORE_SKILL_INVOCATIONS].sort()).toEqual(
      [...EXPECTED_BETA_CHORE_SKILLS].sort(),
    );
  });

  it('treats canonical beta chore lab skill invocations as authoritative inside the Roomote internal repo', () => {
    for (const skillName of EXPECTED_BETA_CHORE_SKILLS) {
      const invocation = `$${skillName}`;
      const { prompt } = standardTask({
        description: `${invocation}\n\nRun the beta chore lab workflow.`,
        repo: 'Roomote/example-app',
        requestFormat: 'structured',
      });

      expect(prompt.startsWith(`${invocation}\n<request>`)).toBe(true);
    }
  });

  it('treats beta chore lab skill invocations as authoritative in other customer repos too', () => {
    for (const skillName of EXPECTED_BETA_CHORE_SKILLS) {
      const invocation = `$${skillName}`;
      const { prompt } = standardTask({
        description: `${invocation}\n\nRun the beta chore lab workflow.`,
        repo: 'acme/widgets',
        requestFormat: 'structured',
      });

      expect(prompt.startsWith(`${invocation}\n<request>`)).toBe(true);
    }
  });

  it('keeps repo-local skill invocations inside the request wrapper', () => {
    const { prompt, harnessInstructions } = standardTask({
      description:
        '$agent-guidance-maintenance\n\n<task_context><target>agent-guidance</target></task_context>',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('<request>$agent-guidance-maintenance')).toBe(
      true,
    );
    expect(harnessInstructions).toContain(
      'If the user explicitly invokes a discoverable repo-local skill by name, let the active harness resolve that invocation instead of forcing it back through the three first-hop workflows.',
    );
  });

  it('treats a single selected repository as a child of the shared workspace root when workspace repositories are available', () => {
    const { harnessInstructions } = standardTask({
      description: 'Inspect the repo layout and update the workflow text.',
      repo: 'Roomote/example-app',
      repoFullNames: ['Roomote/example-app'],
    });

    expect(harnessInstructions).toContain(
      'Use the workspace root as your base directory for operations',
    );
    expect(harnessInstructions).toContain('Available repositories:');
    expect(harnessInstructions).toContain('- Roomote/example-app');
    expect(harnessInstructions).not.toContain(
      '<workspace_context>Single repository workspace.</workspace_context>',
    );
  });
});
