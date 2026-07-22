const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization))(\s*[:=]\s*)\S+/gi,
];

const HASH_SHAPED_PATTERNS: RegExp[] = [
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, ...groups) =>
      typeof groups[0] === 'string' && typeof groups[1] === 'string'
        ? `${groups[0]}${groups[1]}[redacted]`
        : '[redacted]',
    );
  }
  for (const pattern of HASH_SHAPED_PATTERNS) {
    redacted = redacted.replace(
      pattern,
      (match) => `${match.slice(0, 8)}…[redacted]`,
    );
  }
  return redacted;
}
