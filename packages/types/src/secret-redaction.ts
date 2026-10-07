type SecretKeyPolicy =
  | 'diagnostic'
  | 'diagnostic-text'
  | 'integration'
  | 'webhook'
  | 'environment';
interface SecretTextOptions {
  placeholder?: string;
  policy?: 'published' | 'log' | 'diagnostic' | 'brain';
  namedAssignments?: boolean;
  environmentAssignments?: boolean;
  hashShaped?: boolean;
}

/** Pure, self-contained core: also instantiated in the generated worker plugin. */
export function createSecretRedactor() {
  const privateKeyBlock =
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/;
  // One inventory for published credential formats and optional log heuristics.
  const patterns = [
    { pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/, published: true },
    {
      pattern:
        /\b[sr]k_(?:live|test|org)_(?:(?:live|test)_)?[A-Za-z0-9]{16,}\b/,
      published: true,
    },
    { pattern: /\bwhsec_[A-Za-z0-9]{24,}\b/, published: true },
    {
      pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}/,
      diagnosticPattern: /\bgh[pousr]_[A-Za-z0-9_-]{8,}/,
      published: true,
    },
    {
      pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}/,
      diagnosticPattern: /\bgithub_pat_[A-Za-z0-9_-]{8,}/,
      published: true,
    },
    { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, published: true },
    {
      pattern: /\bxox[a-z]-[A-Za-z0-9-]{8,}/,
      diagnosticPattern: /\bxox[a-z]-[A-Za-z0-9_-]{8,}/,
      published: true,
    },
    { pattern: /\bxapp-[A-Za-z0-9-]{12,}\b/, published: true },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/, published: true },
    { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, published: true },
    { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, published: true },
    {
      pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
      published: true,
    },
    { pattern: /\blin_api_[A-Za-z0-9]{32,}\b/, published: true },
    { pattern: /\bhf_[A-Za-z0-9]{30,}\b/, published: true },
    {
      pattern: privateKeyBlock,
      diagnosticPattern:
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/,
      published: true,
    },
    {
      pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]+)/i,
      published: false,
      auth: true,
    },
    {
      pattern: /\b(eyJ[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/,
      published: false,
      jwt: true,
    },
    { pattern: /\b[A-Fa-f0-9]{40,}\b/, published: false, opaque: true },
    { pattern: /\b[A-Za-z0-9+/]{48,}={0,2}\b/, published: false, opaque: true },
  ];
  // Key policy differs from value detection: webhook free text stays intact;
  // integration previews are conservative; diagnostics preserve count metadata.
  const keyRules = [
    { name: 'secret', webhookSuffix: true },
    { name: 'secrets' },
    { name: 'token', webhookSuffix: true },
    { name: 'password', webhookSuffix: true },
    { name: 'passwd', integration: false },
    { name: 'credential' },
    { name: 'credentials' },
    { name: 'authorization' },
    { name: 'apikey', webhookSuffix: true },
    { name: 'privatekey' },
    { name: 'cookie', integration: false, webhook: false },
    { name: 'cookies', integration: false, webhook: false },
    { name: 'accesskey', integration: false, webhook: false },
    { name: 'databaseurl', integration: false, webhook: false },
    { name: 'connectionstring', integration: false, webhook: false },
    { name: 'key', integration: false, webhook: false, diagnostic: false },
  ];
  // Object methods keep their property names under worker minification, so
  // serializing the factory does not capture external keepNames shims.
  const methods = {
    isSensitiveKey(
      key: string,
      policy: SecretKeyPolicy = 'diagnostic',
    ): boolean {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      // Count metadata is not a free-text exemption: diagnostic assignments
      // retain legacy masking even when their label normalizes to tokenCount.
      if (normalized === 'tokencount' && policy !== 'diagnostic-text')
        return false;
      return keyRules.some((rule) => {
        if (policy === 'diagnostic-text')
          return rule.diagnostic !== false && normalized.includes(rule.name);
        if (policy === 'webhook')
          return (
            rule.webhook !== false &&
            (normalized === rule.name ||
              (rule.webhookSuffix === true && normalized.endsWith(rule.name)))
          );
        if (policy === 'integration')
          return rule.integration !== false && normalized.includes(rule.name);
        return (
          (policy === 'environment' || rule.diagnostic !== false) &&
          normalized.endsWith(rule.name)
        );
      });
    },
    hasSecret(value: string): boolean {
      let candidate = value;
      for (let attempt = 0; attempt <= 4; attempt += 1) {
        if (
          patterns.some(
            ({ pattern, published }) => published && pattern.test(candidate),
          )
        )
          return true;
        if (attempt === 4) break;
        try {
          const decoded = decodeURIComponent(candidate.replace(/\+/g, ' '));
          if (decoded === candidate) return false;
          candidate = decoded;
        } catch {
          return false;
        }
      }
      return false;
    },
    privateKeyRanges(text: string): { start: number; end: number }[] {
      return [...text.matchAll(new RegExp(privateKeyBlock.source, 'g'))].map(
        (match) => ({ start: match.index, end: match.index + match[0].length }),
      );
    },
    keyChar(char: string): boolean {
      return /[A-Za-z0-9_.-]/.test(char);
    },
    // Linear key scan avoids backtracking over long non-secret assignment names.
    maskNamedAssignments(
      text: string,
      placeholder: string,
      policy: NonNullable<SecretTextOptions['policy']>,
    ): string {
      let output = '',
        copyFrom = 0,
        index = 0;
      while (index < text.length) {
        if (!methods.keyChar(text[index]!)) {
          index += 1;
          continue;
        }
        const start = index;
        while (index < text.length && methods.keyChar(text[index]!)) index += 1;
        const key = text.slice(start, index);
        if (
          (text[index] === '"' || text[index] === "'") &&
          (text[start - 1] === text[index] || policy === 'diagnostic')
        )
          index += 1;
        while (index < text.length && /\s/.test(text[index]!)) index += 1;
        if (text[index] !== ':' && text[index] !== '=') continue;
        index += 1;
        if (
          !methods.isSensitiveKey(
            key,
            policy === 'diagnostic' ? 'diagnostic-text' : 'diagnostic',
          )
        )
          continue;
        while (index < text.length && /\s/.test(text[index]!)) index += 1;
        const valueStart = index,
          quote = text[index];
        if (quote === '"' || quote === "'") {
          index += 1;
          while (index < text.length) {
            if (text[index] === '\\') {
              index += 2;
              continue;
            }
            if (text[index++] === quote) break;
          }
        } else if (
          policy === 'diagnostic' ||
          key.toLowerCase().endsWith('authorization')
        ) {
          while (index < text.length && !/[\r\n]/.test(text[index]!))
            index += 1;
        } else {
          while (index < text.length && !/[\s,;}]/.test(text[index]!))
            index += 1;
        }
        if (index === valueStart) continue;
        output += text.slice(copyFrom, valueStart) + placeholder;
        copyFrom = Math.min(index, text.length);
      }
      return copyFrom ? output + text.slice(copyFrom) : text;
    },
    shouldMask(
      entry: (typeof patterns)[number],
      match: readonly unknown[],
      policy: NonNullable<SecretTextOptions['policy']>,
    ): boolean {
      if (entry.published) return true;
      if (entry.opaque || policy === 'published') return false;
      if (policy === 'diagnostic') return true;
      if (entry.auth)
        return (
          typeof match[1] === 'string' &&
          match[1].toLowerCase() === 'bearer' &&
          typeof match[2] === 'string' &&
          match[2].length >= (policy === 'brain' ? 16 : 8)
        );
      return (
        policy === 'log' &&
        entry.jwt === true &&
        typeof match[1] === 'string' &&
        match[1].length >= 13 &&
        typeof match[2] === 'string' &&
        match[2].length >= 10 &&
        typeof match[3] === 'string' &&
        match[3].length >= 5
      );
    },
    maskText(text: string, options: SecretTextOptions = {}): string {
      const placeholder = options.placeholder ?? '[redacted]';
      let masked = text;
      for (const entry of patterns) {
        const { opaque } = entry;
        // Retain legacy diagnostic acceptance without widening other consumers.
        const pattern =
          options.policy === 'diagnostic'
            ? (entry.diagnosticPattern ?? entry.pattern)
            : entry.pattern;
        if (!opaque)
          masked = masked.replace(
            new RegExp(pattern.source, `${pattern.flags}g`),
            (match, ...groups) =>
              methods.shouldMask(
                entry,
                [match, ...groups],
                options.policy ?? 'published',
              )
                ? placeholder
                : match,
          );
      }
      // Scan runs linearly; only attempt decoding runs that actually contain '%'.
      masked = masked.replace(/[^\s"'<>]+/g, (run) =>
        run.includes('%') && methods.hasSecret(run) ? placeholder : run,
      );
      if (options.environmentAssignments)
        masked = masked.replace(
          /^([\t ]*(?:\d+(?:[\t ]*[:|][\t ]*|[\t ]+))?(?:export[\t ]+)?[A-Za-z_][\w.-]*[\t ]*=[\t ]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\r\n]*)/gm,
          `$1${placeholder}`,
        );
      if (options.namedAssignments)
        masked = methods.maskNamedAssignments(
          masked,
          placeholder,
          options.policy ?? 'published',
        );
      if (options.hashShaped)
        for (const { pattern, opaque } of patterns) {
          if (opaque)
            masked = masked.replace(
              new RegExp(pattern.source, 'g'),
              (match) => `${match.slice(0, 8)}…${placeholder}`,
            );
        }
      return masked;
    },
  };
  return {
    maskText: methods.maskText,
    hasSecret: methods.hasSecret,
    isSensitiveKey: methods.isSensitiveKey,
    privateKeyRanges: methods.privateKeyRanges,
  };
}

export const secretRedactor = createSecretRedactor();
