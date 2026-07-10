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

const SECRET_PATTERNS: RegExp[] = [
  // Provider/API key prefixes and bearer headers.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  // key=value / key: value assignments for credential-ish names, including
  // prefixed forms like DATABASE_PASSWORD or GITHUB_TOKEN.
  /([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization))(\s*[:=]\s*)\S+/gi,
];

// Long opaque hex/base64 runs are token-shaped, but they are also what git
// SHAs and content digests look like — post-mortem evidence this rail exists
// to preserve. These keep an 8-character prefix: enough to identify a commit
// or digest, far too little to reconstruct a credential.
const HASH_SHAPED_PATTERNS: RegExp[] = [
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups) => {
      // Assignment pattern keeps the key name for readability.
      if (typeof groups[0] === 'string' && typeof groups[1] === 'string') {
        return `${groups[0]}${groups[1]}[redacted]`;
      }

      return '[redacted]';
    });
  }

  for (const pattern of HASH_SHAPED_PATTERNS) {
    redacted = redacted.replace(
      pattern,
      (match) => `${match.slice(0, 8)}…[redacted]`,
    );
  }

  return redacted;
}

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

interface DiagnosticEventRecorder {
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
