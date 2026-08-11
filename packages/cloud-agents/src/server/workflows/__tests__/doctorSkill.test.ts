import fs from 'node:fs';
import path from 'node:path';

const skillPath = path.resolve(
  import.meta.dirname,
  '../skills/standard/doctor/SKILL.md',
);

function readSkillContent() {
  return fs.readFileSync(skillPath, 'utf8');
}

describe('doctor guidance', () => {
  it('uses a fresh Roomote task as the end-to-end health check', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      "Use Roomote's existing task runtime as the end-to-end health check",
    );
    expect(skillContent).toContain(
      'call `mcp__roomote__manage_tasks` with `action: "list_environments"`',
    );
    expect(skillContent).toContain(
      'Call `mcp__roomote__manage_tasks` with `action: "launch"`, that `environmentId`, and `notifyOnSettle: true`.',
    );
    expect(skillContent).toContain(
      'call `mcp__roomote__manage_tasks` with `action: "get_summary"` every 10-15 seconds',
    );
    expect(skillContent).toContain(
      'call `mcp__roomote__manage_tasks` with `action: "get_messages"`',
    );
    expect(skillContent).toContain(
      'Do not replace that end-to-end evidence with a parallel collection of technology-specific probes.',
    );
    expect(skillContent).not.toContain('diagnose_environment');
    expect(skillContent).not.toContain('complete_doctor_report');
  });

  it('prevents recursive or mutating verification tasks', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Its prompt must not invoke Doctor or another packaged skill, delegate another task, repair anything, update the environment, edit repository files, create commits, or open a pull request.',
    );
    expect(skillContent).toContain('Doctor is read-only by default.');
    expect(skillContent).toContain(
      'If the user explicitly requested repair and ownership is `environment_configuration`, transition to the packaged `environment-setup` workflow',
    );
    expect(skillContent).toContain(
      'If the user explicitly requested repair and ownership is `repository`, transition to `implement-changes`',
    );
  });

  it('derives generic goals without assuming a workload technology', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain('There is no universal Doctor checklist.');
    expect(skillContent).toContain(
      'Do not invent a startup, service, preview, browser, port, test, build, migration, performance, clean-tree, container, process-supervisor, or database requirement.',
    );
    expect(skillContent).toContain(
      'These are examples, not a closed taxonomy.',
    );
    expect(skillContent).toContain(
      'The launched task must not assume the repository is a web app.',
    );
    expect(skillContent).toContain(
      "discover the repository's intended developer entrypoint and prove that it starts and performs its basic documented function",
    );
    expect(skillContent).toContain(
      'If the repository has no runnable application, it must say so and verify the nearest evidence-backed workflow instead of inventing an app or server.',
    );
    expect(skillContent).toContain(
      'command exit and output, produced artifacts, a completed job and observable effect, migration result, protocol behavior, test result, measured operation, or a completed browser interaction',
    );
  });

  it('requires a real result rather than inferring success from task completion', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'A completed task state is not proof that the goal passed',
    );
    expect(skillContent).toContain(
      'report `ready`, `not_ready`, or `blocked` with the exact attempted steps and secret-safe evidence',
    );
    expect(skillContent).toContain(
      'Do not claim `healthy` or `repaired` unless the latest fresh task explicitly completed the requested journey',
    );
  });

  it('keeps browser verification layered and conditional', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Only when the requested goal includes a Roomote browser preview',
    );
    expect(skillContent).toContain(
      'the authenticated external `ROOMOTE_<NAME>_PREVIEW_URL` with the installed `agent-browser` wrapper',
    );
    expect(skillContent).toContain(
      'inspect page errors, console errors, and failed or blocked journey-critical network requests',
    );
    expect(skillContent).toContain(
      'document HTTP 2xx/3xx alone is insufficient',
    );
  });

  it('classifies ownership by the durable correction boundary', () => {
    const skillContent = readSkillContent();

    for (const owner of [
      'environment_configuration',
      'repository',
      'roomote_platform',
      'external_dependency',
      'undetermined',
    ]) {
      expect(skillContent).toContain(`\`${owner}\``);
    }

    expect(skillContent).toContain(
      'Never classify ownership from a symptom or technology name alone.',
    );
    expect(skillContent).toContain(
      'For CORS or allowed-host failures, identify the expected origin or host, reproduce it through the actual route, and locate the rejecting boundary.',
    );
    expect(skillContent).toContain(
      'Never repair an origin or host-policy failure with a wildcard, disabled host checking, reflective origin behavior, or broadly permissive CORS.',
    );
  });

  it('requires fresh verification after repair', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'After an authorized repair, require another task launched against the newly persisted environment and repeat the original goal.',
    );
    expect(skillContent).toContain(
      "Never use the pre-repair task, the repair workflow's successful return, or the current sandbox as proof.",
    );
  });
});
