import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact-secrets';
import { redactBrainText } from './redact-brain-text';

describe.each([redactSecrets, redactBrainText])(
  'Session capability redaction',
  (redact) => {
    it.each(['a', '-', '_'])(
      'redacts proxy URL credentials with final character %s',
      (last) => {
        const token = `rproxy_${'a'.repeat(42)}${last}`;
        const text = `HTTPS_PROXY=https://workload:${token}@proxy.example.com:8444/`;
        expect(redact(text)).not.toContain(token);
        expect(redact(text)).toContain('proxy.example.com');
      },
    );
    it('redacts a Session substitute without removing ordinary text', () => {
      const token = `rses_${'a'.repeat(40)}`;
      expect(redact(`service token ${token}; keep this text`)).not.toContain(
        token,
      );
      expect(redact('keep this text')).toBe('keep this text');
    });
  },
);
