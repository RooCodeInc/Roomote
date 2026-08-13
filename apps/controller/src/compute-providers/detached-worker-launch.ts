/**
 * Shared reporting for detached `worker <command>` launches that exit before
 * claiming their task run. The spawn-*-worker modules throw this error so the
 * worker's captured stderr/stdout reaches task_runs.error instead of being
 * lost with the destroyed sandbox.
 */

const LAUNCH_OUTPUT_TEXT_LIMIT = 500;

// The detached launch line inlines worker env vars (`env AUTH_TOKEN=...
// worker run ...`), so shell diagnostics can echo credential values. Redact
// secret-looking assignments before the output reaches the run error / UI.
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][\w]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[\w]*)=(?:"[^"]*"|'[^']*'|\S+)/gi;

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

  const trimmed = value
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1=<redacted>')
    .trim();

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
