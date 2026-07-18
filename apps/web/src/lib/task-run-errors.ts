import { stripRunErrorMarkers } from '@roomote/types';

interface TaskRunErrorSource {
  error?: string | null;
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
const DOCKER_WORKER_IMAGE_REF =
  /(?:Unable to find image ['"](?<image>[^'"]+)['"] locally|pull access denied for (?<deniedImage>[^\s,]+)|Error response from daemon: pull access denied for (?<deniedImageAlt>[^\s,]+))/i;
const DOCKER_COMMAND_FAILED_PREFIX = /^Docker command failed \(([^)]+)\):\n?/;

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

function getDockerBootDisplayMessage(error: string): string | undefined {
  const imageMatch = error.match(DOCKER_WORKER_IMAGE_REF);
  const image =
    imageMatch?.groups?.image?.trim() ||
    imageMatch?.groups?.deniedImage?.trim() ||
    imageMatch?.groups?.deniedImageAlt?.trim();

  if (image) {
    return `Roomote couldn't start because the worker image \`${image}\` is missing or can't be pulled. Build or pull that image on the host (for local Docker, run the worker image build), or set DOCKER_WORKER_IMAGE to an image the host can access.`;
  }

  if (
    /Docker worker container exited before task run #\d+ started/i.test(error)
  ) {
    const logsMatch = error.match(/Recent Docker logs:\n([\s\S]+)$/i);
    const logs = logsMatch?.[1]?.trim();

    if (logs) {
      return `Roomote started a worker container, but it exited before the environment came up.\n\n${logs}`;
    }

    return 'Roomote started a worker container, but it exited before the environment came up. Check controller and Docker worker logs on the host for details.';
  }

  if (
    /Docker worker command for task run #\d+ was not observed during startup/i.test(
      error,
    )
  ) {
    return 'Roomote started a worker container, but the sandbox process never became ready. The host may be under load, or the worker failed before reporting status. Check Docker worker logs on the host.';
  }

  if (
    /Job\s+\S+\s+failed:\s*fetch failed/i.test(error) ||
    /^❌?\s*Job\s+\S+\s+failed:\s*fetch failed\s*$/im.test(error) ||
    /^fetch failed$/i.test(error.trim())
  ) {
    return 'Roomote reached the worker, but the sandbox failed while contacting the Roomote API (`fetch failed`). Check that the API is reachable from the worker network and that API/controller URLs are configured correctly.';
  }

  // Prefer the docker daemon detail block over a raw "Command failed: docker run …" dump.
  const dockerFailedMatch = error.match(DOCKER_COMMAND_FAILED_PREFIX);

  if (dockerFailedMatch) {
    const detail = error.slice(dockerFailedMatch[0].length).trim();

    if (detail) {
      return `Docker failed while starting the environment:\n${detail}`;
    }
  }

  if (/^Command failed:\s*docker\b/i.test(error)) {
    const detail = error
      .replace(/^Command failed:\s*docker(?:\s+[^\n]+)?\n?/i, '')
      .trim();

    if (detail) {
      return `Docker failed while starting the environment:\n${detail}`;
    }
  }

  return undefined;
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
): string | undefined {
  const stripped = stripRunErrorMarkers(error);

  if (!stripped) {
    return undefined;
  }

  const workspacePreparationMessage =
    getWorkspacePreparationDisplayMessage(stripped);

  if (workspacePreparationMessage) {
    return workspacePreparationMessage;
  }

  const dockerBootMessage = getDockerBootDisplayMessage(stripped);

  if (dockerBootMessage) {
    return dockerBootMessage;
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
  return getTaskRunErrorDisplayMessage(getTaskRunError(taskRun));
}
