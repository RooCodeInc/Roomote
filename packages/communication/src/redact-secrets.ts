const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(authorization)(\s*:\s*)[^\r\n]*/gi,
];

const HASH_SHAPED_PATTERNS: RegExp[] = [
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
];

const SECRET_ASSIGNMENT_KEY_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'api-key',
];

function isAssignmentKeyChar(char: string): boolean {
  const code = char.charCodeAt(0);

  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122) ||
    code === 45
  );
}

function isWhitespace(char: string): boolean {
  return char.trim().length === 0;
}

function isSecretAssignmentKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return SECRET_ASSIGNMENT_KEY_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix),
  );
}

function redactSecretAssignments(text: string): string {
  let output = '';
  let copyFrom = 0;
  let index = 0;

  while (index < text.length) {
    if (!isAssignmentKeyChar(text[index]!)) {
      index += 1;
      continue;
    }

    const keyStart = index;
    while (index < text.length && isAssignmentKeyChar(text[index]!)) {
      index += 1;
    }
    const keyEnd = index;

    while (index < text.length && isWhitespace(text[index]!)) {
      index += 1;
    }

    if (text[index] !== ':' && text[index] !== '=') {
      continue;
    }

    const separatorIndex = index;
    if (!isSecretAssignmentKey(text.slice(keyStart, keyEnd))) {
      index = separatorIndex + 1;
      continue;
    }

    index = separatorIndex + 1;
    while (index < text.length && isWhitespace(text[index]!)) {
      index += 1;
    }
    const valueStart = index;

    while (index < text.length && !isWhitespace(text[index]!)) {
      index += 1;
    }

    if (index === valueStart) {
      continue;
    }

    output += text.slice(copyFrom, keyStart);
    output += `${text.slice(keyStart, keyEnd)}${text.slice(keyEnd, valueStart)}[redacted]`;
    copyFrom = index;
  }

  return copyFrom === 0 ? text : output + text.slice(copyFrom);
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, ...groups) =>
      typeof groups[0] === 'string' && typeof groups[1] === 'string'
        ? `${groups[0]}${groups[1]}[redacted]`
        : '[redacted]',
    );
  }
  redacted = redactSecretAssignments(redacted);
  for (const pattern of HASH_SHAPED_PATTERNS) {
    redacted = redacted.replace(
      pattern,
      (match) => `${match.slice(0, 8)}…[redacted]`,
    );
  }
  return redacted;
}
