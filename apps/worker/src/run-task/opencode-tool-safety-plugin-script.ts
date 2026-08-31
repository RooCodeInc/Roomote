export const OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME =
  'ROOMOTE_OPENCODE_REDACT_ENV_NAMES';

export const OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT = `import { realpath } from 'node:fs/promises';

const UNSUPPORTED_READ_IMAGE_EXTENSIONS = new Set(['.cur', '.ico']);
const MIN_REDACTED_ENV_VALUE_LENGTH = 8;
const REDACT_ENV_NAMES_ENV_VAR_NAME = '${OPENCODE_REDACT_ENV_NAMES_ENV_VAR_NAME}';

function getRedactedEnvValues() {
  let names;

  try {
    names = JSON.parse(process.env[REDACT_ENV_NAMES_ENV_VAR_NAME] ?? '[]');
  } catch {
    return [];
  }

  if (!Array.isArray(names)) {
    return [];
  }

  return [...new Set(
    names.flatMap((name) => {
      if (typeof name !== 'string') {
        return [];
      }

      const value = process.env[name];
      return value
        ? [value, value.trim()].filter(
            (candidate) =>
              candidate.length >= MIN_REDACTED_ENV_VALUE_LENGTH,
          )
        : [];
    }),
  )].sort((left, right) => right.length - left.length);
}

function redactKnownEnvValues(value) {
  let redacted = value;

  for (const secret of getRedactedEnvValues()) {
    redacted = redacted.replaceAll(secret, '[redacted]');
  }

  return redacted;
}

function getReadPath(input, context) {
  const args = context?.args ?? input?.args;

  if (!args || typeof args !== 'object') {
    return undefined;
  }

  return typeof args.filePath === 'string'
    ? args.filePath
    : typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : undefined;
}

function getExtension(filePath) {
  const normalized = filePath.split(/[?#]/u, 1)[0]?.toLowerCase() ?? '';
  const basename = normalized.split(/[\\/]/u).pop() ?? '';
  const extensionIndex = basename.lastIndexOf('.');

  return extensionIndex >= 0 ? basename.slice(extensionIndex) : '';
}

async function resolvesToUnsupportedImage(filePath) {
  if (UNSUPPORTED_READ_IMAGE_EXTENSIONS.has(getExtension(filePath))) {
    return true;
  }

  try {
    const resolvedPath = await realpath(filePath.split(/[?#]/u, 1)[0]);
    return UNSUPPORTED_READ_IMAGE_EXTENSIONS.has(getExtension(resolvedPath));
  } catch {
    // Let the read tool report missing or inaccessible paths itself.
    return false;
  }
}

export const RoomoteOpenCodeToolSafety = async () => ({
  'tool.execute.before': async (input, context) => {
    if (input?.tool !== 'read') {
      return;
    }

    const filePath = getReadPath(input, context);

    if (!filePath || !(await resolvesToUnsupportedImage(filePath))) {
      return;
    }

    throw new Error(
      'The read tool cannot safely attach ICO or CUR image files to the model conversation. ' +
        'Inspect metadata with a text-only command or convert the image to PNG in a temporary directory first.',
    );
  },
  'tool.execute.after': async (_input, output) => {
    if (output && typeof output.output === 'string') {
      output.output = redactKnownEnvValues(output.output);
    }
  },
});
`;
