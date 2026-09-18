const BASE_PACKAGES = new Set([
  'base',
  'compiler',
  'datasets',
  'graphics',
  'grDevices',
  'grid',
  'methods',
  'parallel',
  'splines',
  'stats',
  'stats4',
  'tcltk',
  'tools',
  'utils',
]);

type RAnalysisPreflight = {
  packages: string[];
  unresolvedPackageExpressions: string[];
};

export function parseRAttachmentText(
  text: string,
): { filename: string; source: string } | null {
  const prefix = text.startsWith('File attachment:')
    ? 'File attachment:'
    : text.startsWith('Attachment:')
      ? 'Attachment:'
      : null;
  if (!prefix) return null;

  const newline = text.indexOf('\n', prefix.length);
  if (newline < 0) return null;

  let filename = text.slice(prefix.length, newline).trim();
  if (prefix === 'File attachment:' && filename.endsWith(')')) {
    const mimeStart = filename.lastIndexOf(' (');
    const mimeType = mimeStart >= 0 ? filename.slice(mimeStart + 2, -1) : '';
    if (mimeType.includes('/')) {
      filename = filename.slice(0, mimeStart).trim();
    }
  }
  if (!filename.toLowerCase().endsWith('.r')) return null;

  const rawSource = text.slice(newline + 1);
  const beginMarker = '----- BEGIN ATTACHMENT -----\n';
  const endMarker = '\n----- END ATTACHMENT -----';
  const envelopedSource = rawSource.startsWith(beginMarker)
    ? rawSource.slice(beginMarker.length)
    : null;
  const source = envelopedSource?.endsWith(endMarker)
    ? envelopedSource.slice(0, -endMarker.length)
    : (envelopedSource ?? rawSource);

  return { filename, source };
}

function isIdentifierStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === '.'
  );
}

function isIdentifierPart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57) || char === '_';
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (isWhitespace(source[index])) index++;
  return index;
}

function skipQuotedString(source: string, start: number): number {
  const quote = source[start];
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === quote) return index + 1;
  }
  return source.length;
}

function stripComments(source: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === '\n') {
      result += char;
      escaped = false;
      continue;
    }
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (char === '#') {
      while (index + 1 < source.length && source[index + 1] !== '\n') index++;
      continue;
    }
    result += char;
  }
  return result;
}

function readCallBody(source: string, openParen: number): string | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openParen + 1; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0)
      return source.slice(openParen + 1, index);
  }
  return null;
}

function splitTopLevelArguments(body: string): string[] {
  const arguments_: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      arguments_.push(body.slice(start, index));
      start = index + 1;
    }
  }
  arguments_.push(body.slice(start));
  return arguments_;
}

function namedArgument(
  argument: string,
): { name: string; value: string } | null {
  const equals = argument.indexOf('=');
  if (equals < 0) return null;
  const name = argument.slice(0, equals).trim();
  if (!isPackageName(name)) return null;
  return { name, value: argument.slice(equals + 1).trim() };
}

function normalizePackageArgument(argument: string): string {
  let value = argument.trim();
  if (value.startsWith('package')) {
    const equals = value.indexOf('=');
    if (equals >= 0 && value.slice(0, equals).trim() === 'package') {
      value = value.slice(equals + 1).trim();
    }
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isPackageName(value: string): boolean {
  if (!isIdentifierStart(value[0])) return false;
  for (let index = 1; index < value.length; index++) {
    if (!isIdentifierPart(value[index])) return false;
  }
  return true;
}

export function inspectRAnalysisScript(source: string): RAnalysisPreflight {
  const code = stripComments(source);
  const packages = new Map<string, string>();
  const unresolved = new Set<string>();

  for (let index = 0; index < code.length;) {
    if (code[index] === '"' || code[index] === "'") {
      index = skipQuotedString(code, index);
      continue;
    }
    if (!isIdentifierStart(code[index])) {
      index++;
      continue;
    }
    const start = index++;
    while (isIdentifierPart(code[index])) index++;
    const identifier = code.slice(start, index);
    const afterIdentifier = skipWhitespace(code, index);

    if (code.startsWith('::', afterIdentifier)) {
      if (!BASE_PACKAGES.has(identifier))
        packages.set(identifier.toLowerCase(), identifier);
      continue;
    }

    if (
      (identifier !== 'library' && identifier !== 'require') ||
      code[afterIdentifier] !== '('
    ) {
      continue;
    }
    const body = readCallBody(code, afterIdentifier);
    if (body === null) continue;
    const arguments_ = splitTopLevelArguments(body);
    const packageArgument =
      arguments_
        .map((argument) => ({ argument, named: namedArgument(argument) }))
        .find(({ named }) => named?.name === 'package')?.named?.value ??
      arguments_.find((argument) => namedArgument(argument) === null) ??
      '';
    const packageName = normalizePackageArgument(packageArgument);
    const characterOnly = arguments_.some((argument) => {
      const named = namedArgument(argument);
      return named?.name === 'character.only' && named.value === 'TRUE';
    });
    if (characterOnly) {
      if (packageName) unresolved.add(packageName);
    } else if (isPackageName(packageName) && !BASE_PACKAGES.has(packageName)) {
      packages.set(packageName.toLowerCase(), packageName);
    }
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.localeCompare(b)),
    unresolvedPackageExpressions: [...unresolved].sort(),
  };
}
