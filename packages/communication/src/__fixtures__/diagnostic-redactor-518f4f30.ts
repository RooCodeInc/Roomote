// Frozen test-only excerpt from packages/communication/src/redact-secrets.ts
// at 518f4f3074d5c69c9eb790e317352434cc5c60b8. Keep this baseline unchanged:
// shallow CI checkouts and source archives must not need Git history to test it.
/** Worker-safe and self-contained so the same sanitizer can run in the tool hook. */
export function redactToolData<T>(
  value: T,
  secretValues: readonly string[] = [],
): T {
  const sensitiveKey =
    /(?:authorization|cookies?|credentials?|password|passwd|secret|token|private[_-]?key|api[_-]?key|access[_-]?key|database[_-]?url|connection[_-]?string)$/i;
  const envKey =
    /^(?:env|environment|environmentVariables|environment_variables)$/i;
  const pm2NumericMetadata = new Set([
    'pm_id',
    'restart_time',
    'unstable_restarts',
    'created_at',
    'pm_uptime',
    'exit_code',
    'instances',
  ]);
  const pm2Statuses = new Set([
    'online',
    'stopped',
    'stopping',
    'errored',
    'launching',
    'waiting restart',
    'one-launch-status',
  ]);
  const isPm2Metadata = (key: string, item: unknown): boolean => {
    if (pm2NumericMetadata.has(key))
      return typeof item === 'number' && Number.isFinite(item);
    if (key === 'status')
      return typeof item === 'string' && pm2Statuses.has(item);
    return (
      key === 'exec_mode' && (item === 'fork_mode' || item === 'cluster_mode')
    );
  };
  const redactText = (text: string): string => {
    for (const secret of secretValues) {
      if (secret.length >= 8) text = text.split(secret).join('[redacted]');
    }
    if (/^\s*[[{]/u.test(text)) {
      try {
        return JSON.stringify(walk(JSON.parse(text)));
      } catch {
        // Truncated/line-numbered output still needs text-level redaction.
      }
    }
    return (
      text
        // Environment-file names need not look like credentials. Keep names,
        // but mask values, including multiline quotes and diagnostic line prefixes.
        .replace(
          /^([\t ]*(?:\d+(?:[\t ]*[:|][\t ]*|[\t ]+))?(?:export[\t ]+)?[A-Za-z_][\w.-]*[\t ]*=[\t ]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\r\n]*)/gm,
          '$1[redacted]',
        )
        .replace(
          /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
          '[redacted]',
        )
        .replace(
          /\b(?:sk-|rk-|gh[pousr]_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{8,}/g,
          '[redacted]',
        )
        .replace(
          /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
          '[redacted]',
        )
        .replace(
          /(["']?[\w.-]*(?:authorization|cookie|credential|password|passwd|secret|token|private[_-]?key|api[_-]?key|access[_-]?key|database[_-]?url|connection[_-]?string)[\w.-]*["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\r\n,;}]+)/gi,
          '$1[redacted]',
        )
        .replace(
          /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
          '[redacted]',
        )
    );
  };
  const walk = (item: unknown, environment = false, pm2 = false): unknown => {
    if (environment && (item === null || typeof item !== 'object'))
      return '[redacted]';
    if (typeof item === 'string') return redactText(item);
    if (Array.isArray(item))
      return item.map((entry) => walk(entry, environment));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ||
        (pm2 && !envKey.test(key) && !isPm2Metadata(key, entry))
          ? '[redacted]'
          : walk(entry, environment || envKey.test(key), key === 'pm2_env'),
      ]),
    );
  };
  return walk(value) as T;
}
