import { createSecretRedactor, secretRedactor } from '@roomote/types';

/** Compose the existing log masker and unbounded diagnostic tree policy. */
export function createDiagnosticRedactor(
  core: ReturnType<typeof createSecretRedactor> = createSecretRedactor(),
) {
  const redactor = {
    redactSecrets(
      text: string,
      options: {
        environmentAssignments?: boolean;
        hashShaped?: boolean;
        policy?: 'log' | 'diagnostic';
      } = {},
    ): string {
      return core.maskText(text, {
        policy: options.policy ?? 'log',
        namedAssignments: true,
        hashShaped: options.hashShaped ?? true,
        environmentAssignments: options.environmentAssignments,
      });
    },
    redactToolData<T>(value: T, secretValues: readonly string[] = []): T {
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
      const traversal = {
        isPm2Metadata(key: string, item: unknown): boolean {
          if (pm2NumericMetadata.has(key))
            return typeof item === 'number' && Number.isFinite(item);
          if (key === 'status')
            return typeof item === 'string' && pm2Statuses.has(item);
          return (
            key === 'exec_mode' &&
            (item === 'fork_mode' || item === 'cluster_mode')
          );
        },
        redactText(text: string): string {
          for (const secret of secretValues) {
            if (secret.length >= 8)
              text = text.split(secret).join('[redacted]');
          }
          if (/^\s*[[{]/u.test(text)) {
            try {
              return JSON.stringify(traversal.walk(JSON.parse(text)));
            } catch {
              /* Partial/line-numbered text still needs the shared masker. */
            }
          }
          // Tool content has no preview bounds or opaque-string/hash shortening.
          return redactor.redactSecrets(text, {
            policy: 'diagnostic',
            environmentAssignments: true,
            hashShaped: false,
          });
        },
        walk(item: unknown, environment = false, pm2 = false): unknown {
          if (environment && (item === null || typeof item !== 'object'))
            return '[redacted]';
          if (typeof item === 'string') return traversal.redactText(item);
          if (Array.isArray(item))
            return item.map((entry) => traversal.walk(entry, environment));
          if (!item || typeof item !== 'object') return item;
          return Object.fromEntries(
            Object.entries(item).map(([key, entry]) => [
              key,
              core.isSensitiveKey(key) ||
              (pm2 && !envKey.test(key) && !traversal.isPm2Metadata(key, entry))
                ? '[redacted]'
                : traversal.walk(
                    entry,
                    environment || envKey.test(key),
                    key === 'pm2_env',
                  ),
            ]),
          );
        },
      };
      return traversal.walk(value) as T;
    },
  };
  return redactor;
}

export const { redactSecrets, redactToolData } =
  createDiagnosticRedactor(secretRedactor);
