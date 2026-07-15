import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);
const skillPath = path.resolve(
  thisDirPath,
  '../skills/standard/environment-setup/SKILL.md',
);

function readSkillContent() {
  return fs.readFileSync(skillPath, 'utf8');
}

describe('environment-setup guidance', () => {
  it('requests known-required environment variables proactively', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'When repository evidence makes required environment keys clear but values are unavailable, request them immediately instead of waiting for a command to fail',
    );
    expect(skillContent).toContain(
      'As soon as repository evidence or early validation makes it clear that specific environment variables or secrets will be required and values are unavailable, request them immediately instead of waiting for a later failure.',
    );
    expect(skillContent).toContain(
      'When required environment variables or secrets are known but unavailable in a web dashboard task or Slack-started setup task, use `request_environment_variables` and never ask the user to paste secret values into the conversation.',
    );
    expect(skillContent).toContain(
      'still send a concise `send_chat_reply` message with `purpose` set to `progress` naming the required keys and what they unblock',
    );
    expect(skillContent).toContain(
      'do not add the secure `/setup` link yourself because the platform automatically accompanies that request with a standardized secure-entry link reply',
    );
  });

  it('allows revising an existing environment instead of always creating a new one', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'When the task explicitly identifies an existing environment to revise, update that environment instead of creating a duplicate.',
    );
  });

  it('tells the agent to keep environment names plain instead of decorated variants', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Choose a plain, stable environment `name` based on the product or repository itself.',
    );
    expect(skillContent).toContain(
      'Do not decorate it with qualifiers like `Localhost`, `Minimal`, `Dev`, or similar unless the user explicitly asked for multiple distinct variants.',
    );
  });

  it('preserves exact repository identifiers including Azure DevOps segments', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Use each provided repository identifier exactly as supplied by the task.',
    );
    expect(skillContent).toContain(
      'Azure DevOps uses `organization/project/repository`.',
    );
    expect(skillContent).toContain(
      'Copy each task-provided repository identifier verbatim into its matching `repositories[].repository` field.',
    );
    expect(skillContent).not.toContain(
      'Use the provided repository identifier in `owner/repo` format',
    );
  });

  it('tells the agent how to discover and start supported worker services', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'run `worker services` to see the full list and `worker service <name>` to install and start one service.',
    );
  });

  it('forbids mocked-service fallbacks and tells the agent to ask the user for help', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Do not invent mocked, stubbed, or fake replacement services just to get the app booting.',
    );
    expect(skillContent).toContain(
      'If repository evidence and supported worker tooling are still insufficient to get a required real service running, ask the user for help with that service before proceeding instead of inventing a fallback.',
    );
  });

  it('allows clearly pre-existing repo test failures to be reported without blocking environment creation', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'Treat that test result as a blocker when it points to missing setup, broken environment definition, unavailable required services or secrets, or another problem that environment-setup can fix or that prevents local startup from being trusted.',
    );
    expect(skillContent).toContain(
      'When the test failure instead appears to be a clearly pre-existing repository or unit-test failure outside environment-setup scope, record the exact command and failure',
    );
    expect(skillContent).toContain(
      'Do not treat clearly pre-existing repository or unit-test failures as automatic blockers to environment creation when install/start/localhost validation succeeds',
    );
    expect(skillContent).toContain(
      'When tests fail but are treated as non-blocking because they appear to be pre-existing repository issues outside environment-setup scope',
    );
  });

  it('tells the agent to set initialUrl for browser-backed environments', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'When the repository exposes a browser UI or a stable localhost landing page, populate `initialUrl` with the best validated absolute URL so the shared live browser does not start at `about:blank`.',
    );
    expect(skillContent).toContain(
      'confirm that localhost URL through loopback HTTP reachability and startup evidence',
    );
    expect(skillContent).toContain(
      'Do not use direct browser automation from `environment-setup`.',
    );
    expect(skillContent).not.toContain('agent-browser');
  });

  it('tells the agent to configure preview ports for human-facing web surfaces', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'When a validated localhost HTTP surface is meant for humans in a browser (particularly a web app UI), also add a matching top-level `ports` entry so Roomote publishes a shareable preview URL and a `ROOMOTE_<NAME>_HOST` environment variable for it',
    );
    expect(skillContent).toContain(
      'Keep the `ports` list limited to human-facing surfaces validated during setup; do not add ports for databases, background workers, or internal-only APIs that no human would open in a browser.',
    );
    expect(skillContent).toContain(
      'When the config includes a `ports` entry for a validated HTTP surface, confirm its `port` number matches the actual validated listening port and that any `initial_path` responds successfully over loopback.',
    );
    expect(skillContent).toContain(
      'When a validated human-facing HTTP surface exists (particularly a web app UI), configure a matching top-level `ports` entry so the environment publishes a shareable preview URL for it',
    );
    expect(skillContent).toContain(
      '<field name="ports" required="false" type="NamedPort[]" />',
    );
    expect(skillContent).toContain('<named_port_config>');
  });

  it('uses and validates checked-in Compose or Dockerfile projects', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'prefer a top-level `docker_projects` entry over translating its containers into Roomote-managed `services` or detached repository commands',
    );
    expect(skillContent).toContain(
      'run `docker compose config --quiet` against the selected files or an equivalent generated one-service Compose model',
    );
    expect(skillContent).toContain(
      '<field name="docker_projects" required="false" type="DockerProject[]" />',
    );
    expect(skillContent).toContain('<docker_project_config>');
    expect(skillContent).toContain('<docker_project_port>');
  });

  it('launches a follow-up verification task after persisting the environment', () => {
    const skillContent = readSkillContent();

    expect(skillContent).toContain(
      'After successful environment persistence, use the Roomote MCP tool `mcp__roomote__manage_tasks` to launch a lightweight verification task against the created or updated environment and monitor it yourself instead of leaving verification as an implicit manual next step.',
    );
    expect(skillContent).toContain(
      'For that follow-up task launch, call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "list_environments"` first so you can confirm the created or updated environment appears as a current launch target and copy the exact returned `environmentId`.',
    );
    expect(skillContent).toContain(
      'Then call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "launch"`, `environmentId` set to that created or updated environment ID, `notifyOnSettle` set to `true`',
    );
    expect(skillContent).toContain(
      'First read .roomote/setup-status.json in the workspace root: while its state is "running", environment setup commands are still executing in the background',
    );
    expect(skillContent).toContain(
      "If any setup command failed, report each failing command's name and exit code from .roomote/setup-status.json plus the relevant error lines from its log under .roomote/setup-logs/.",
    );
    expect(skillContent).toContain(
      'the platform delivers a `Spawned task update` message into this session when the verification task settles',
    );
    expect(skillContent).toContain(
      'Treat that message as the primary completion signal',
    );
    expect(skillContent).toContain(
      'While waiting for that settle notification, periodically check the verification task with the Roomote MCP tool `mcp__roomote__manage_tasks` using `action: "get_summary"` and the returned `taskId` as a fallback signal.',
    );
    expect(skillContent).toContain(
      'treat `failed` or `completed with warnings` as direct evidence that specific setup commands failed even when the verification task has not described the failure yet',
    );
    expect(skillContent).toContain(
      'relaunch the verification task with `notifyOnSettle: true`, and wait for the new settle notification',
    );
    expect(skillContent).toContain(
      'Narrate concise, plain-language progress updates while the follow-up check runs',
    );
    expect(skillContent).toContain(
      'Preparing the environment can take 5 minutes or more, so do not stop monitoring just because startup is taking a long time.',
    );
    expect(skillContent).toContain(
      'If the monitored summary reaches `Ready`, `Idle`, or `Needs input`, do not keep polling that same state indefinitely.',
    );
    expect(skillContent).toContain(
      'If those latest task messages clearly report that the environment looks ready, treat that as a successful spawned-task run and report the observed success directly.',
    );
    expect(skillContent).toContain(
      'If the monitored summary reaches `Completed` without a surfaced startup or runtime failure, treat that as a successful spawned-task run and report that observed outcome directly instead of asking the user to confirm it manually.',
    );
    expect(skillContent).toContain(
      'When the spawned verification task reveals a fixable setup or environment-definition error, try to fix it yourself, rerun any affected local validation, recreate or update the environment with the revised YAML, launch a fresh verification task, and repeat the monitoring process instead of stopping after the first failure.',
    );
    expect(skillContent).toContain(
      'Retry at most 2 additional full environment-update-plus-verification attempts after the first spawned verification task',
    );
    expect(skillContent).toContain(
      'If the observed verification error appears to require product or source-code changes outside environment-setup scope',
    );
    expect(skillContent).not.toContain('monitoring limit');
    expect(skillContent).toContain(
      'When setup succeeds, begin with a plain-language outcome sentence such as `Your environment is ready.`',
    );
    expect(skillContent).toContain(
      'Describe internal orchestration in user terms.',
    );
    expect(skillContent).toContain(
      "[Create a new task](/) and describe what you'd like done.",
    );
    expect(skillContent).toContain(
      'This is the final visible paragraph; do not append an internal status summary after it.',
    );
    expect(skillContent).toContain(
      'Do not mention a spawned task, task status, polling, or monitoring in those user-facing updates.',
    );
    expect(skillContent).not.toContain(
      'When the verification task completed cleanly, report that the spawned verification task completed.',
    );
    expect(skillContent).toContain(
      'Never include the full environment YAML in your visible response or Slack reply.',
    );
    expect(skillContent).toContain(
      "derive one minimal Roomote environment configuration for Roomote's environment editor and `manage_environments`",
    );
    expect(skillContent).toContain(
      'Produce one environment definition that is valid for the Roomote environment editor.',
    );
    expect(skillContent).toContain(
      'Always derive a best-effort environment definition that is ready to work once required environment variables are supplied.',
    );
    expect(skillContent).toContain(
      'The final environment definition is best-effort and should be runnable once required environment variables are provided.',
    );
    expect(skillContent).toContain('repositories:');
    expect(skillContent).not.toContain('workspace manifest');
    expect(skillContent).not.toContain(
      "produce one minimal Roomote environment configuration YAML that is directly usable in Roomote's environment editor",
    );
    expect(skillContent).not.toContain(
      'Produce one environment YAML that is valid for the Roomote environment editor.',
    );
    expect(skillContent).not.toContain(
      'Always produce a best-effort YAML that is ready to work once required environment variables are supplied.',
    );
    expect(skillContent).not.toContain(
      'The final YAML is best-effort and should be runnable once required environment variables are provided.',
    );
    expect(skillContent).not.toContain('- `YAML:`');
    expect(skillContent).not.toContain(
      'Under `YAML:`, output only one fenced code block labeled `yaml` containing exactly one Roomote environment configuration.',
    );
    expect(skillContent).not.toContain(
      'confirm the environment works before clicking Continue',
    );
    expect(skillContent).toContain(
      'Do not expose the spawned verification task link in the user-facing response.',
    );
    expect(skillContent).not.toContain('[Open verification task](https://...)');
  });
});
