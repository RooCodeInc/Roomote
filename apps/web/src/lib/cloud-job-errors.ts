import { stripRunErrorMarkers } from '@roomote/types';

interface CloudJobErrorSource {
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

export function getCloudJobError(
  cloudJob?: CloudJobErrorSource | null,
): string | undefined {
  if (typeof cloudJob?.error === 'string' && cloudJob.error.trim()) {
    return cloudJob.error;
  }

  const result = cloudJob?.result;

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }

  const resultError = (result as Record<string, unknown>).error;

  if (typeof resultError === 'string' && resultError.trim()) {
    return resultError;
  }

  return undefined;
}

export function getCloudJobErrorDisplayMessage(
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

  const openAiMatch = stripped.match(OPENAI_ADMIN_ERROR_PREFIX);

  if (!openAiMatch) {
    return stripped;
  }

  const status = openAiMatch[1];
  const body = openAiMatch[2]?.trim() ?? '';
  const parsedBody = parseOpenAiAdminErrorBody(body);
  const providerMessage = parsedBody?.error?.message?.trim();

  if (parsedBody?.error?.code === 'invalid_api_key') {
    return 'Model provider request failed because a configured provider key is invalid. Check ROOMOTE_MODEL, ROOMOTE_SMALL_MODEL, ROOMOTE_VISION_MODEL, and the matching provider API key env vars.';
  }

  if (providerMessage) {
    return `Model provider request failed (${status}): ${providerMessage}`;
  }

  if (body) {
    return `Model provider request failed (${status}): ${body}`;
  }

  return `Model provider request failed (${status}).`;
}

export function getCloudJobDisplayError(
  cloudJob?: CloudJobErrorSource | null,
): string | undefined {
  return getCloudJobErrorDisplayMessage(getCloudJobError(cloudJob));
}
