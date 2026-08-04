export const OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT = `const UNSUPPORTED_READ_IMAGE_EXTENSIONS = new Set(['.cur', '.ico']);

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

export const RoomoteOpenCodeToolSafety = async () => ({
  'tool.execute.before': async (input, context) => {
    if (input?.tool !== 'read') {
      return;
    }

    const filePath = getReadPath(input, context);

    if (!filePath || !UNSUPPORTED_READ_IMAGE_EXTENSIONS.has(getExtension(filePath))) {
      return;
    }

    throw new Error(
      'The read tool cannot safely attach ICO or CUR image files to the model conversation. ' +
        'Inspect metadata with a text-only command or convert the image to PNG in a temporary directory first.',
    );
  },
});
`;
