import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const isManagedSessionProxyEnv = (name: string) =>
  /^ROOMOTE_SERVICE_TOKEN_[A-Z0-9_]+$/.test(name) ||
  [
    'ROOMOTE_SESSION_PROXY_URL',
    'ROOMOTE_SESSION_PROXY_CA_FILE',
    'ROOMOTE_SESSION_EGRESS_SERVICES',
    'ROOMOTE_SESSION_EGRESS_ADMISSION_MODE',
    'ROOMOTE_SESSION_PROXY_CAPABILITY_EXPIRES_AT',
  ].includes(name);

export const sessionProxyEnvFilePath = (commonEnvFile: string) =>
  join(dirname(commonEnvFile), 'session-services.env');

/** Atomically replace scoped shell configuration; never edit a running process's env. */
export function writeSessionProxyEnvFile(
  path: string,
  environment: Record<string, string>,
): void {
  const selected: Record<string, string> = {};
  const lines = [
    '# Worker-managed Session proxy configuration. Contains scoped credentials.',
    'command -p -v env >/dev/null && command -p -v sed >/dev/null || return 1',
    // A here-document keeps the loop in the selected shell and avoids both
    // Bash-only expansion and shell-specific word splitting (including custom IFS).
    'while IFS= read -r __roomote_service; do',
    '  if [ -n "$__roomote_service" ]; then unset "$__roomote_service" || return 1; fi',
    'done <<__ROOMOTE_SERVICE_NAMES__',
    "$(command -p env | command -p sed -n 's/^\\(ROOMOTE_SERVICE_TOKEN_[A-Z0-9_]*\\)=.*$/\\1/p')",
    '__ROOMOTE_SERVICE_NAMES__',
    'unset __roomote_service ROOMOTE_SESSION_PROXY_URL ROOMOTE_SESSION_PROXY_CA_FILE ROOMOTE_SESSION_EGRESS_SERVICES ROOMOTE_SESSION_EGRESS_ADMISSION_MODE ROOMOTE_SESSION_PROXY_CAPABILITY_EXPIRES_AT',
  ];
  for (const [name, value] of Object.entries(environment)) {
    if (!isManagedSessionProxyEnv(name)) continue;
    if (
      name.startsWith('ROOMOTE_SERVICE_TOKEN_') &&
      !/^rses_[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new Error(
        'Session proxy file requires scoped substitutes, not real credentials',
      );
    }
    lines.push(`export ${name}='${value.replaceAll("'", "'\\''")}'`);
    selected[name] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const jsonTemporary = `${temporary}.json`;
  try {
    writeFileSync(temporary, `${lines.join('\n')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temporary, 0o600);
    writeFileSync(jsonTemporary, JSON.stringify({ environment: selected }), {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(jsonTemporary, 0o600);
    renameSync(jsonTemporary, `${path}.json`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(jsonTemporary, { force: true });
  }
}
