import { TaskRunErrorCode, stripRunErrorMarkers } from '@roomote/types';

interface TaskRunErrorSource {
  error?: string | null;
  errorCode?: string | null;
  result?: unknown | null;
}

type OpenAiAdminErrorResponse = {
  error?: {
    message?: string;
    code?: string | null;
  };
};

const OPENAI_ADMIN_ERROR_PREFIX =
  /^OpenAI admin request failed \((\d{3})\):\s*([\s\S]+)$/;
const MISSING_REMOTE_BRANCH_DURING_WORKSPACE_PREP =
  /^Failed to prepare 1 workspace repository:\n- (?<repository>[^:]+):[\s\S]*?git checkout -B (?<branch>\S+) origin\/\S+[\s\S]*?stderr -> fatal: 'origin\/[^']+' is not a commit and a branch '[^']+' cannot be created from it$/;

const DOCKER_DAEMON_UNAVAILABLE =
  /Cannot connect to the Docker daemon|failed to connect to the [Dd]ocker API|Is the docker daemon running|connect: no such file or directory.*docker\.sock/i;
const DOCKER_IMAGE_MISSING_OR_UNAUTHORIZED =
  /pull access denied|repository does not exist or may require ['"]?docker login['"]?|manifest for .+ not found|Unable to find image ['"].+['"] locally/i;
const DOCKER_PORT_IN_USE =
  /port is already allocated|bind: address already in use|failed to bind host port/i;
const DOCKER_WORKER_START_TIMEOUT =
  /Docker worker for task run #\d+ did not start within \d+s|Docker worker command for task run #\d+ was not observed during startup/i;
const DOCKER_WORKER_EXITED_EARLY =
  /Docker worker container exited before task run #\d+ started/i;
const DOCKER_RELEASE_ARCHIVE_MISSING =
  /Docker worker release archive does not exist|Docker provider requires a local worker release archive/i;
const DOCKER_FETCH_FAILED_IN_LOGS =
  /Job\s+<\s*unknown\s*>\s*failed:\s*fetch failed|❌[^\n]*failed:\s*fetch failed/i;
// Roomote Cloud compute broker capacity rejection (code sandbox_limit_reached).
const SANDBOX_LIMIT_REACHED =
  /tenant sandbox limit was reached|sandbox_limit_reached/i;
const SANDBOX_LIMIT_REACHED_MESSAGE =
  "Roomote couldn't start a new sandbox because this deployment is already running its maximum number of concurrent sandboxes. Wait for an active task to finish, or stop one you no longer need, then try again.";

function parseOpenAiAdminErrorBody(
  body: string,
): OpenAiAdminErrorResponse | null {
  try {
    return JSON.parse(body) as OpenAiAdminErrorResponse;
  } catch {
    return null;
  }
}

function getWorkspacePreparationDisplayMessage(
  error: string,
): string | undefined {
  const match = error.match(MISSING_REMOTE_BRANCH_DURING_WORKSPACE_PREP);

  if (!match?.groups) {
    return undefined;
  }

  const repository = match.groups.repository?.trim();
  const branch = match.groups.branch?.trim();

  if (!repository || !branch) {
    return undefined;
  }

  return `Roomote couldn't start because the configured branch \`${branch}\` for \`${repository}\` no longer exists on GitHub. Update the repository branch setting, or leave it blank to use the repository's default branch.`;
}

function extractDockerDiagnosticReason(error: string): string | undefined {
  const reasonBlocks = error
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of reasonBlocks) {
    if (
      /^Failed to run docker\b/i.test(block) ||
      /^command:\s*$/i.test(block) ||
      /^command:\n/i.test(block) ||
      /^exit code:/i.test(block) ||
      /^stdout:/i.test(block) ||
      /^stderr:/i.test(block)
    ) {
      continue;
    }

    if (
      /pull access denied|Unable to find image|Error response from daemon|Cannot connect to the Docker daemon|failed to connect to the docker API|port is already allocated|fetch failed/i.test(
        block,
      )
    ) {
      return block;
    }
  }

  return undefined;
}

const DOCKER_ERROR_CODE_MESSAGES: Record<TaskRunErrorCode, string> = {
  [TaskRunErrorCode.DockerDaemonUnreachable]:
    "Roomote couldn't reach the Docker daemon. Make sure Docker Desktop (or the Docker Engine) is running and that this host can access the Docker socket.",
  [TaskRunErrorCode.DockerImageMissing]:
    "Roomote couldn't find or pull the worker image. For local/self-hosted setups, build the worker image first (for example `roomote-worker:local`) and confirm the image name matches your configuration.",
  [TaskRunErrorCode.DockerPortInUse]:
    "Roomote couldn't start the sandbox because a required host port is already in use. Stop the other process using that port, then retry.",
  [TaskRunErrorCode.DockerWorkerFetchFailed]:
    'The sandbox worker failed while contacting the Roomote API (`fetch failed`). Confirm the worker can reach the API URL from inside Docker (often via `host.docker.internal`) and that the API is running.',
  [TaskRunErrorCode.DockerWorkerStartTimeout]:
    'The sandbox container started, but the Roomote worker did not come up in time. Check that the worker image and local worker release archive are present, then retry. Diagnostic details are included below when available.',
  [TaskRunErrorCode.DockerWorkerExitedEarly]:
    'The sandbox container exited during boot before the worker started. Review the recent Docker logs below for the underlying crash or missing dependency.',
  [TaskRunErrorCode.DockerReleaseArchiveMissing]:
    'Roomote is missing the local worker release archive required to boot Docker sandboxes. Build the worker release (for example via the local development worker-release step) and retry.',
  [TaskRunErrorCode.DeploymentReadOnly]:
    'This deployment is read-only. New task launches are paused until access is restored.',
};

/** The persisted code may come from a newer or older release — trust it only
 * when this build knows its copy. */
function resolveDockerErrorCodeMessage(
  errorCode?: string | null,
): string | undefined {
  return errorCode && Object.hasOwn(DOCKER_ERROR_CODE_MESSAGES, errorCode)
    ? DOCKER_ERROR_CODE_MESSAGES[errorCode as TaskRunErrorCode]
    : undefined;
}

/** Text-inference fallback for runs persisted before error codes existed. */
function getDockerSpawnDisplayMessage(error: string): string | undefined {
  if (DOCKER_DAEMON_UNAVAILABLE.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[TaskRunErrorCode.DockerDaemonUnreachable];
  }

  if (DOCKER_IMAGE_MISSING_OR_UNAUTHORIZED.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[TaskRunErrorCode.DockerImageMissing];
  }

  if (DOCKER_PORT_IN_USE.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[TaskRunErrorCode.DockerPortInUse];
  }

  // Prefer the more specific worker-side fetch failure over generic timeout/exit.
  if (DOCKER_FETCH_FAILED_IN_LOGS.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[TaskRunErrorCode.DockerWorkerFetchFailed];
  }

  if (DOCKER_WORKER_START_TIMEOUT.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[
      TaskRunErrorCode.DockerWorkerStartTimeout
    ];
  }

  if (DOCKER_WORKER_EXITED_EARLY.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[TaskRunErrorCode.DockerWorkerExitedEarly];
  }

  if (DOCKER_RELEASE_ARCHIVE_MISSING.test(error)) {
    return DOCKER_ERROR_CODE_MESSAGES[
      TaskRunErrorCode.DockerReleaseArchiveMissing
    ];
  }

  return undefined;
}

/**
 * Prefer a short, action-oriented explanation and keep useful Docker
 * diagnostics attached so self-hosted operators can still see the raw cause.
 */
function composeDockerDisplayMessage(friendly: string, error: string): string {
  const diagnostic = extractDockerDiagnosticReason(error);

  if (!diagnostic || friendly.includes(diagnostic)) {
    // The controller attaches "Recent Docker logs:" on early container exit
    // and "Docker process list:" on worker start timeout — keep either one.
    const trailerMatch = error.match(
      /(Recent Docker logs|Docker process list):\n([\s\S]+)$/i,
    );
    if (trailerMatch?.[2]?.trim()) {
      return `${friendly}\n\n${trailerMatch[1]}:\n${trailerMatch[2].trim()}`;
    }

    return friendly;
  }

  return `${friendly}\n\nDetails:\n${diagnostic}`;
}

export function getTaskRunError(
  taskRun?: TaskRunErrorSource | null,
): string | undefined {
  if (typeof taskRun?.error === 'string' && taskRun.error.trim()) {
    return taskRun.error;
  }

  const result = taskRun?.result;

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }

  const resultError = (result as Record<string, unknown>).error;

  if (typeof resultError === 'string' && resultError.trim()) {
    return resultError;
  }

  return undefined;
}

export function getTaskRunErrorDisplayMessage(
  error?: string | null,
  errorCode?: string | null,
): string | undefined {
  const stripped = stripRunErrorMarkers(error);

  if (!stripped) {
    // A categorized failure is still explainable without diagnostic text.
    return resolveDockerErrorCodeMessage(errorCode);
  }

  const workspacePreparationMessage =
    getWorkspacePreparationDisplayMessage(stripped);

  if (workspacePreparationMessage) {
    return workspacePreparationMessage;
  }

  if (SANDBOX_LIMIT_REACHED.test(stripped)) {
    return SANDBOX_LIMIT_REACHED_MESSAGE;
  }

  // The persisted category is authoritative; text inference covers runs
  // that failed before error codes existed.
  const dockerFriendly =
    resolveDockerErrorCodeMessage(errorCode) ??
    getDockerSpawnDisplayMessage(stripped);

  if (dockerFriendly) {
    return composeDockerDisplayMessage(dockerFriendly, stripped);
  }

  // Promote Docker diagnostics ahead of the raw argv "command:" trailer.
  if (/^Failed to run docker\b/i.test(stripped)) {
    const diagnostic = extractDockerDiagnosticReason(stripped);
    if (diagnostic) {
      const withoutCommandOnly = stripped.replace(
        /\n\ncommand:\n[\s\S]*$/i,
        '',
      );
      return withoutCommandOnly.trim() || diagnostic;
    }
  }

  const openAiMatch = stripped.match(OPENAI_ADMIN_ERROR_PREFIX);

  if (!openAiMatch) {
    return stripped;
  }

  const status = openAiMatch[1];
  const body = openAiMatch[2]?.trim() ?? '';
  const parsedBody = parseOpenAiAdminErrorBody(body);
  const providerMessage = parsedBody?.error?.message?.trim();

  if (parsedBody?.error?.code === 'invalid_api_key') {
    return 'Model provider request failed because a configured provider key is invalid. Check R_MODEL, R_SMALL_MODEL, R_VISION_MODEL, and the matching provider API key env vars.';
  }

  if (providerMessage) {
    return `Model provider request failed (${status}): ${providerMessage}`;
  }

  if (body) {
    return `Model provider request failed (${status}): ${body}`;
  }

  return `Model provider request failed (${status}).`;
}

export function getTaskRunDisplayError(
  taskRun?: TaskRunErrorSource | null,
): string | undefined {
  return getTaskRunErrorDisplayMessage(
    getTaskRunError(taskRun),
    taskRun?.errorCode,
  );
}
