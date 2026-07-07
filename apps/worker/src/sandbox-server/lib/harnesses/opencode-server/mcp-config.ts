import { asRecord, asString } from '@roomote/types';

import type { DirectMcpConfig } from '../direct-mcp-config';

export function parseDirectMcpConfig(config: unknown): DirectMcpConfig | null {
  const record = asRecord(config);
  const type = asString(record?.type);

  if (type === 'streamable-http') {
    const url = asString(record?.url);

    if (!url) {
      return null;
    }

    const headers = Object.fromEntries(
      Object.entries(asRecord(record?.headers) ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );

    return { type, url, headers };
  }

  if (type === 'stdio') {
    const command = asString(record?.command);

    if (!command) {
      return null;
    }

    const args = Array.isArray(record?.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : [];

    const env = Object.fromEntries(
      Object.entries(asRecord(record?.env) ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );

    return { type, command, args, env };
  }

  return null;
}

export function resolveHeaderEnvVarNameForOpenCode(
  value: string,
): string | null {
  const envVarMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(value.trim());

  return envVarMatch?.[1] ?? null;
}
