import { createDiagnosticRedactor } from '@roomote/communication/redact-secrets';
import { createSecretRedactor } from '@roomote/types';

export const OPENCODE_TOOL_SAFETY_PLUGIN_SCRIPT = `import { realpath } from 'node:fs/promises';

const secretRedactor = (${createSecretRedactor.toString()})();
const { redactToolData } = (${createDiagnosticRedactor.toString()})(secretRedactor);

const UNSUPPORTED_READ_IMAGE_EXTENSIONS = new Set(['.cur', '.ico']);

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
    const command = context?.args?.command ?? input?.args?.command;
    if (input?.tool === 'bash' && typeof command === 'string' &&
        /\\bpm2\\b[^\\r\\n;&|]*\\b(?:jlist|prettylist|env)\\b|\\bprintenv\\b|(?:^|[;&|]\\s*)env\\s*(?:$|[;&|])/u.test(command)) {
      throw new Error('Use allowlisted process metadata instead of environment-value diagnostics.');
    }
    const diagnosticPath = getReadPath(input, context);
    if (input?.tool === 'read' && typeof diagnosticPath === 'string' &&
        /(?:^|[\\\\/])(?:on-demand-mcp-servers\\.json|\\.env(?:\\.[^\\\\/]*)?)$/u.test(diagnosticPath)) {
      throw new Error('Inspect configuration metadata without environment values or authorization headers.');
    }
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
    const secretValues = Object.entries(process.env)
      .filter(([name]) => secretRedactor.isSensitiveKey(name, 'environment'))
      .map(([, value]) => value).filter((value) => typeof value === 'string');
    if (typeof output.output === 'string') output.output = redactToolData(output.output, secretValues);
    if (output.metadata) output.metadata = redactToolData(output.metadata, secretValues);
  },
});
`;
