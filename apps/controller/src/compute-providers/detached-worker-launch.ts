/**
 * Shared reporting for detached `worker <command>` launches that exit before
 * claiming their task run. The spawn-*-worker modules throw this error so the
 * worker's captured stderr/stdout reaches task_runs.error instead of being
 * lost with the destroyed sandbox.
 */

const LAUNCH_OUTPUT_TEXT_LIMIT = 500;

// The detached launch line inlines the entire worker env (`env AUTH_TOKEN=...
// worker run ...`), and some of those values are credentials whose names have
// no tell-tale suffix (e.g. auth-bypass values). Shell diagnostics can echo
// that whole line — and some adapters quote each KEY=value token — so redact
// the value of every env-style assignment rather than pattern-matching
// "secret-looking" names. Launch env keys are platform-constructed and
// upper-case, so scoping to upper-case keys keeps ordinary diagnostic text
// (e.g. `exitCode=1`) readable. Quoted whole-token alternatives come first in
// the pattern so their closing quote is preserved instead of being swallowed
// as part of the value; a single pass keeps replacements from re-matching.
const ENV_ASSIGNMENT_PATTERN =
  /'([A-Z][A-Z0-9_]*)=[^']*'|"([A-Z][A-Z0-9_]*)=[^"]*"|\b([A-Z][A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g;

function redactEnvAssignments(value: string): string {
  return value.replace(
    ENV_ASSIGNMENT_PATTERN,
    (_match, singleQuoted, doubleQuoted, bare) =>
      singleQuoted
        ? `'${singleQuoted}=<redacted>'`
        : doubleQuoted
          ? `"${doubleQuoted}=<redacted>"`
          : `${bare}=<redacted>`,
  );
}

export class DetachedWorkerLaunchError extends Error {
  public readonly details: Record<string, unknown>;

  public constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'DetachedWorkerLaunchError';
    this.details = details;
  }
}

function truncateLaunchOutput(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = redactEnvAssignments(value).trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > LAUNCH_OUTPUT_TEXT_LIMIT
    ? `${trimmed.slice(0, LAUNCH_OUTPUT_TEXT_LIMIT)}...`
    : trimmed;
}

export function buildDetachedWorkerExitError(
  command: string,
  result: {
    exitCode: number | null;
    commandId?: string;
    stdout?: string;
    stderr?: string;
  },
): DetachedWorkerLaunchError {
  const stdout = truncateLaunchOutput(result.stdout);
  const stderr = truncateLaunchOutput(result.stderr);
  const parts = [
    `Detached "worker ${command}" exited immediately with code ${result.exitCode}`,
  ];

  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }

  if (stdout) {
    parts.push(`stdout: ${stdout}`);
  }

  return new DetachedWorkerLaunchError(parts.join('\n'), {
    commandId: result.commandId ?? null,
    exitCode: result.exitCode,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  });
}
