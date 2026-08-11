import { standardTask } from '../standardTask';
import { PACKAGED_AUTOMATION_SKILL_INVOCATIONS } from '../skillInvocationRouting';
import { buildStructuredTaskRequest } from '../utils';

describe('Standard Task explicit invocation routing', () => {
  it('skips the four-workflow initial routing step when the request already starts with a packaged-skill invocation', () => {
    const { prompt, harnessInstructions } = standardTask({
      description:
        '$review-code\n\n<active_appendix_path>review-github-pr</active_appendix_path>',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$review-code\n<request>')).toBe(true);
    expect(harnessInstructions).toContain(
      "If the user's request begins with an explicit Roomote-shipped packaged-skill invocation, treat that invocation as the authoritative initial skill selection and execute that exact skill first.",
    );
    expect(harnessInstructions).toContain(
      'skip the four-workflow initial routing step entirely',
    );
    expect(harnessInstructions).toContain(
      'Roomote-shipped packaged skills take precedence for ordinary natural-language first-hop routing, even when repo-local skills are discoverable in the current workspace.',
    );
    expect(harnessInstructions).toContain(
      'If the user explicitly invokes a discoverable repo-local skill by name, let the active harness resolve that invocation instead of forcing it back through the four first-hop workflows.',
    );
  });

  it('separates general non-repository work from repository explanation', () => {
    const { harnessInstructions } = standardTask({
      description: 'Check the logs and tell me whether the retries stopped',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      '`explore-and-act` for ordinary non-repository questions, investigations, and exact user-requested actions across connected systems, documents, messages, web sources, and other available resources',
    );
    expect(harnessInstructions).toContain(
      '`explain-repo-code` for questions specifically about source behavior, architecture, code location, or implementation rationale',
    );
  });

  it('renders source-question routing to the repository explanation workflow', () => {
    const { harnessInstructions } = standardTask({
      description: 'Where is retry logic implemented?',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'route source behavior, architecture, code-location, and implementation-rationale questions to `explain-repo-code`',
    );
    expect(harnessInstructions).toContain(
      'route connected-system questions and actions to `explore-and-act`',
    );
  });

  it('reserves implementation routing for repository and workspace work', () => {
    const { harnessInstructions } = standardTask({
      description:
        'Acknowledge the incident in our connected monitoring system',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      '`implement-changes` for repository or workspace implementation, fixes, file edits, commands, validation, and delivery',
    );
    expect(harnessInstructions).toContain(
      'route connected-system questions and actions to `explore-and-act`',
    );
  });

  it('requires ordinary natural-language requests to enter the selected packaged workflow before repository work', () => {
    const { harnessInstructions } = standardTask({
      description: 'Fix one low-risk maintainer rough edge and validate it',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
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

  it('routes mixed requests by target and otherwise defaults to plan', () => {
    const { harnessInstructions } = standardTask({
      description: 'Maybe adjust the agent routing behavior if needed',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).toContain(
      'When the request is mixed or ambiguous, route repository or workspace execution to `implement-changes`',
    );
    expect(harnessInstructions).toContain(
      'route connected-system questions and actions to `explore-and-act`',
    );
    expect(harnessInstructions).toContain(
      'Mutation intent wins: if any part of the request asks to modify repository or workspace state, run commands in the repository or workspace, validate changes, or deliver code, route to `implement-changes` even when another part asks for external investigation.',
    );
    expect(harnessInstructions).toContain(
      'If the request remains ambiguous after applying those routing rules, default the initial route to `plan-repo-implementation`.',
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

  it('treats GitHub management invocations as packaged-skill entry', () => {
    const { prompt } = standardTask({
      description: '$github-management\n\nCreate a priority label.',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$github-management\n<request>')).toBe(true);
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

  it('treats productized CodeQL triage invocations as packaged-skill entry in customer repos', () => {
    const { prompt } = standardTask({
      description:
        '$codeql-triage\n\n<task_context><source>background-automation</source></task_context>',
      repo: 'acme/widgets',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('$codeql-triage\n<request>')).toBe(true);
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

  // Independent catalog of packaged automation skills that should route as
  // authoritative entry points for every repo. Hardcoded here on purpose so a
  // future edit that drops a skill from the production list also has to
  // delete its line below; otherwise the equality assertion below catches
  // the drift instead of letting both lists shrink in lockstep.
  const EXPECTED_AUTOMATION_SKILLS = [
    'code-quality-auditor',
    'fix-sentry-error',
    'refactor-code',
    'security-auditor',
    'triage-better-stack',
    'triage-sentry',
  ] as const;

  it('exposes the packaged automation skill catalog as authoritative entry points', () => {
    expect([...PACKAGED_AUTOMATION_SKILL_INVOCATIONS].sort()).toEqual(
      [...EXPECTED_AUTOMATION_SKILLS].sort(),
    );
  });

  it('treats canonical automation skill invocations as authoritative inside the Roomote internal repo', () => {
    for (const skillName of EXPECTED_AUTOMATION_SKILLS) {
      const invocation = `$${skillName}`;
      const { prompt } = standardTask({
        description: `${invocation}\n\nRun the automation workflow.`,
        repo: 'Roomote/example-app',
        requestFormat: 'structured',
      });

      expect(prompt.startsWith(`${invocation}\n<request>`)).toBe(true);
    }
  });

  it('treats automation skill invocations as authoritative in other customer repos too', () => {
    for (const skillName of EXPECTED_AUTOMATION_SKILLS) {
      const invocation = `$${skillName}`;
      const { prompt } = standardTask({
        description: `${invocation}\n\nRun the automation workflow.`,
        repo: 'acme/widgets',
        requestFormat: 'structured',
      });

      expect(prompt.startsWith(`${invocation}\n<request>`)).toBe(true);
    }
  });

  it('keeps repo-local skill invocations inside the request wrapper', () => {
    const { prompt, harnessInstructions } = standardTask({
      description:
        '$roomote-testing-validation\n\n<task_context><target>validation</target></task_context>',
      repo: 'Roomote/example-app',
      requestFormat: 'structured',
    });

    expect(prompt.startsWith('<request>$roomote-testing-validation')).toBe(
      true,
    );
    expect(harnessInstructions).toContain(
      'If the user explicitly invokes a discoverable repo-local skill by name, let the active harness resolve that invocation instead of forcing it back through the four first-hop workflows.',
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
