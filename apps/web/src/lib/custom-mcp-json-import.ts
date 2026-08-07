import { CUSTOM_MCP_SERVER_NAME_PATTERN } from '@roomote/types';

/**
 * Parser for the "paste JSON" import in the custom MCP server dialog.
 *
 * MCP servers are distributed as JSON snippets (`{"mcpServers": {...}}` in
 * most docs, `{"servers": {...}}` in VS Code's), so the add dialog accepts a
 * pasted snippet and prefills the form from it. This module is the pure
 * parsing half: it never touches the form, and import is a create-time
 * prefill only; edits keep the field-by-field dialog because blank secret
 * values there mean "keep the stored value".
 *
 * Snippets that launch `mcp-remote` are converted to remote servers on the
 * upstream URL: routing the HTTP server through the Roomote proxy keeps
 * credentials out of the sandbox and enables per-tool deny lists, both of
 * which a sandbox-local mcp-remote process would lose.
 */

export interface CustomMcpJsonImport {
  /** Sanitized server name, or null when the snippet had no usable name. */
  name: string | null;
  transport: 'remote' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  stdio?: { command: string; args?: string[]; env?: Record<string, string> };
  /** Human-readable conversion notes to surface next to the prefilled form. */
  notes: string[];
}

const WRAPPER_KEYS = ['mcpServers', 'servers'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function looksLikeServerConfig(record: Record<string, unknown>): boolean {
  return (
    typeof record.command === 'string' ||
    typeof record.url === 'string' ||
    typeof record.serverUrl === 'string'
  );
}

/**
 * Best-effort conversion of a snippet's server key into a valid server name.
 * Returns null when nothing usable remains; the form then keeps whatever the
 * user already typed.
 */
export function sanitizeCustomMcpServerName(raw: string): string | null {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);

  return CUSTOM_MCP_SERVER_NAME_PATTERN.test(sanitized) ? sanitized : null;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Recognize `npx -y mcp-remote <url> [flags]` (and direct `mcp-remote <url>`)
 * launcher configs and extract the remote server they wrap. `--header` pairs
 * carry over; any other flags are reported as dropped rather than silently
 * discarded.
 */
function convertMcpRemoteLauncher(
  command: string,
  args: string[],
): { url: string; headers?: Record<string, string>; notes: string[] } | null {
  const isMcpRemote =
    command.replace(/^.*\//, '') === 'mcp-remote' ||
    args.some((argument) => argument === 'mcp-remote');

  if (!isMcpRemote) {
    return null;
  }

  const url = args.find(isHttpUrl);

  if (!url) {
    return null;
  }

  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  const consumed = new Set<string>(['-y', '--yes', 'mcp-remote', url]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;

    if (consumed.has(argument)) {
      continue;
    }

    const headerPair =
      argument === '--header'
        ? args[index + 1]
        : argument.startsWith('--header=')
          ? argument.slice('--header='.length)
          : undefined;

    if (headerPair !== undefined) {
      if (argument === '--header') {
        index += 1;
      }

      const separator = headerPair.indexOf(':');

      if (separator > 0) {
        headers[headerPair.slice(0, separator).trim()] = headerPair
          .slice(separator + 1)
          .trim();
      } else {
        dropped.push(`--header ${headerPair}`);
      }

      continue;
    }

    dropped.push(argument);
  }

  const notes = [
    'Converted an mcp-remote launcher into a remote server: the Roomote ' +
      'proxy keeps credentials server-side and enables per-tool management.',
    ...(dropped.length > 0
      ? [`Dropped mcp-remote arguments: ${dropped.join(', ')}.`]
      : []),
  ];

  return {
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    notes,
  };
}

function importFromConfig(
  name: string | null,
  config: Record<string, unknown>,
): CustomMcpJsonImport {
  const url =
    typeof config.url === 'string'
      ? config.url
      : typeof config.serverUrl === 'string'
        ? config.serverUrl
        : null;

  if (typeof config.command === 'string' && config.command.trim()) {
    const args = Array.isArray(config.args)
      ? config.args.map((argument) =>
          typeof argument === 'string' ? argument : String(argument),
        )
      : [];

    const remote = convertMcpRemoteLauncher(config.command.trim(), args);

    if (remote) {
      return {
        name,
        transport: 'remote',
        url: remote.url,
        ...(remote.headers ? { headers: remote.headers } : {}),
        notes: remote.notes,
      };
    }

    const env = toStringRecord(config.env);

    return {
      name,
      transport: 'stdio',
      stdio: {
        command: config.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(env ? { env } : {}),
      },
      notes: [],
    };
  }

  if (url) {
    const headers = toStringRecord(config.headers);

    return {
      name,
      transport: 'remote',
      url,
      ...(headers ? { headers } : {}),
      notes: [],
    };
  }

  throw new Error(
    "The pasted config has neither a 'command' nor a 'url' field.",
  );
}

export function parseCustomMcpServerJson(text: string): CustomMcpJsonImport {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The pasted text is not valid JSON.');
  }

  const root = asRecord(parsed);

  if (!root) {
    throw new Error('Paste a JSON object describing one MCP server.');
  }

  for (const wrapperKey of WRAPPER_KEYS) {
    const wrapper = asRecord(root[wrapperKey]);

    if (wrapper) {
      const entries = Object.entries(wrapper).flatMap(([name, value]) => {
        const config = asRecord(value);
        return config ? [[name, config] as const] : [];
      });

      if (entries.length === 0) {
        throw new Error(`'${wrapperKey}' does not contain a server config.`);
      }

      if (entries.length > 1) {
        throw new Error(
          `The snippet contains ${entries.length} servers; paste one server at a time.`,
        );
      }

      const [name, config] = entries[0]!;
      return importFromConfig(sanitizeCustomMcpServerName(name), config);
    }
  }

  if (looksLikeServerConfig(root)) {
    return importFromConfig(null, root);
  }

  const soleEntry = Object.entries(root);

  if (soleEntry.length === 1) {
    const [name, value] = soleEntry[0]!;
    const config = asRecord(value);

    if (config && looksLikeServerConfig(config)) {
      return importFromConfig(sanitizeCustomMcpServerName(name), config);
    }
  }

  throw new Error(
    'Unrecognized snippet shape. Paste an mcpServers snippet or a single ' +
      'server config.',
  );
}
