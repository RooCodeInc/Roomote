import { redactSecrets } from '@roomote/communication/redact-secrets';
import { sdk } from '@roomote/sdk/client';

import type { HarnessLogger } from '../logging';

// Sandbox logs do not survive the sandbox (and Modal exposes none at all), so
// runtime facts worth a post-mortem are recorded as durable `diagnostic` task
// run events instead. Recording is observer-only: it runs on rare events, it
// never throws into the caller, and every string is size-capped and secret-
// scrubbed before it leaves the process.
const MAX_MESSAGE_CHARS = 2_000;
const MAX_DETAIL_STRING_CHARS = 4_000;
const MAX_DETAIL_DEPTH = 4;

export { redactSecrets } from '@roomote/communication/redact-secrets';

function sanitizeString(value: string, maxChars: number): string {
  const capped =
    value.length > maxChars ? `${value.slice(0, maxChars)}…[truncated]` : value;

  return redactSecrets(capped);
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value, MAX_DETAIL_STRING_CHARS);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  if (depth >= MAX_DETAIL_DEPTH) {
    return '[max depth]';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDetailValue(entry, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeDetailValue(entry, depth + 1),
      ]),
    );
  }

  return String(value);
}

export interface DiagnosticEventRecorder {
  record(input: {
    kind: string;
    message: string;
    details?: Record<string, unknown>;
  }): void;
}

export function createDiagnosticEventRecorder(options: {
  runId: number;
  logger: Pick<HarnessLogger, 'warn'>;
}): DiagnosticEventRecorder {
  return {
    record(input) {
      try {
        const details = {
          ...(sanitizeDetailValue(input.details ?? {}, 0) as Record<
            string,
            unknown
          >),
          // Last so a caller-supplied details.kind can never override the
          // recorder's classification.
          kind: input.kind,
        };

        void sdk.taskRuns
          .recordEvent({
            runId: options.runId,
            source: 'worker_runtime',
            eventType: 'diagnostic',
            message: sanitizeString(input.message, MAX_MESSAGE_CHARS),
            details,
          })
          .catch((error: unknown) => {
            options.logger.warn(
              `[diagnostic-events] Failed to record ${input.kind}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      } catch (error) {
        options.logger.warn(
          `[diagnostic-events] Failed to build ${input.kind}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
