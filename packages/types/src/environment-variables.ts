import { z } from 'zod';

export const DEPLOYMENT_ENV_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

// A single PEM block whose body is base64 (optionally whitespace-separated).
// The body charset excludes '-' so multi-block values never match.
const PEM_BLOCK_PATTERN =
  /^"?\s*-----BEGIN ([A-Z0-9 ]+)-----([A-Za-z0-9+/=\s]+)-----END ([A-Z0-9 ]+)-----\s*"?$/;

/**
 * Repairs PEM values whose newlines were mangled on the way in — flattened to
 * spaces by a single-line input paste, encoded as literal `\n` sequences, or
 * wrapped in quotes. Base64 bodies are whitespace-insensitive, so the block is
 * rebuilt in canonical 64-column form. Values that do not look like a single
 * PEM block pass through untouched.
 */
export function normalizePemEnvValue(value: string): string {
  const candidate = value.replace(/\\n/g, '\n').trim();
  const match = candidate.match(PEM_BLOCK_PATTERN);

  if (!match) {
    return value;
  }

  const [, beginLabel, body, endLabel] = match;

  if (!beginLabel || !body || beginLabel !== endLabel) {
    return value;
  }

  const compactBody = body.replace(/\s+/g, '');

  if (!compactBody) {
    return value;
  }

  const wrappedBody = compactBody.match(/.{1,64}/g)?.join('\n') ?? compactBody;

  return `-----BEGIN ${beginLabel}-----\n${wrappedBody}\n-----END ${endLabel}-----\n`;
}

export const deploymentEnvVarNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(255, 'Name must be less than 255 characters')
  .regex(
    DEPLOYMENT_ENV_VAR_NAME_REGEX,
    'Name must be uppercase letters, numbers, and underscores only, starting with a letter',
  );

export type DeploymentEnvVarName = z.infer<typeof deploymentEnvVarNameSchema>;
