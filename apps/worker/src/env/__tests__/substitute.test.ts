import { substituteEnvVars } from '../substitute';

describe('substituteEnvVars', () => {
  const lookup: Record<string, string> = {
    ROOMOTE_API_HOST: 'https://api.example.com',
    ROOMOTE_WEB_HOST: 'https://web.example.com',
    POSTGRES_URL: 'postgres://localhost:5432/db',
    FOO: 'foo-value',
    FOO_BAR: 'foobar-value',
    HOME: '/home/user',
  };

  it('should resolve ${VAR} references', () => {
    const result = substituteEnvVars(
      { R_TRPC_URL: '${ROOMOTE_API_HOST}' },
      lookup,
    );
    expect(result.R_TRPC_URL).toBe('https://api.example.com');
  });

  it('should resolve bare $VAR references', () => {
    const result = substituteEnvVars(
      { R_TRPC_URL: '$ROOMOTE_API_HOST' },
      lookup,
    );
    expect(result.R_TRPC_URL).toBe('https://api.example.com');
  });

  it('should handle multiple substitutions in one value', () => {
    const result = substituteEnvVars(
      { COMBO: '${ROOMOTE_API_HOST}/path?host=${ROOMOTE_WEB_HOST}' },
      lookup,
    );
    expect(result.COMBO).toBe(
      'https://api.example.com/path?host=https://web.example.com',
    );
  });

  it('should handle mixed $VAR and ${VAR} in one value', () => {
    const result = substituteEnvVars(
      { MIXED: '$ROOMOTE_API_HOST and ${ROOMOTE_WEB_HOST}' },
      lookup,
    );
    expect(result.MIXED).toBe(
      'https://api.example.com and https://web.example.com',
    );
  });

  it('should leave unresolved ${VAR} references intact', () => {
    const result = substituteEnvVars({ MISSING: '${DOES_NOT_EXIST}' }, lookup);
    expect(result.MISSING).toBe('${DOES_NOT_EXIST}');
  });

  it('should leave unresolved $VAR references intact', () => {
    const result = substituteEnvVars({ MISSING: '$DOES_NOT_EXIST' }, lookup);
    expect(result.MISSING).toBe('$DOES_NOT_EXIST');
  });

  it('should use greedy identifier match for bare $VAR', () => {
    // $FOO_BAR should resolve as FOO_BAR, not FOO + "_BAR"
    const result = substituteEnvVars({ VAL: '$FOO_BAR' }, lookup);
    expect(result.VAL).toBe('foobar-value');
  });

  it('should resolve ${FOO} and keep suffix literal', () => {
    const result = substituteEnvVars({ VAL: '${FOO}suffix' }, lookup);
    expect(result.VAL).toBe('foo-valuesuffix');
  });

  it('should not expand $(command) syntax', () => {
    const result = substituteEnvVars({ VAL: '$(echo hello)' }, lookup);
    expect(result.VAL).toBe('$(echo hello)');
  });

  it('should not expand backtick syntax', () => {
    const result = substituteEnvVars({ VAL: '`echo hello`' }, lookup);
    expect(result.VAL).toBe('`echo hello`');
  });

  it('should not recursively expand resolved values', () => {
    // If ROOMOTE_API_HOST resolved to something containing ${...},
    // that should NOT be re-expanded.
    const recursiveLookup = {
      FIRST: '${SECOND}',
      SECOND: 'final-value',
    };
    const result = substituteEnvVars({ VAL: '${FIRST}' }, recursiveLookup);
    // Should resolve FIRST to "${SECOND}" (its value), not to "final-value"
    expect(result.VAL).toBe('${SECOND}');
  });

  it('should pass through values without $ unchanged', () => {
    const result = substituteEnvVars({ PLAIN: 'just a plain value' }, lookup);
    expect(result.PLAIN).toBe('just a plain value');
  });

  it('should handle empty values', () => {
    const result = substituteEnvVars({ EMPTY: '' }, lookup);
    expect(result.EMPTY).toBe('');
  });

  it('should handle empty vars input', () => {
    const result = substituteEnvVars({}, lookup);
    expect(result).toEqual({});
  });

  it('should handle empty lookup', () => {
    const result = substituteEnvVars({ VAL: '${ROOMOTE_API_HOST}' }, {});
    expect(result.VAL).toBe('${ROOMOTE_API_HOST}');
  });

  it('should process multiple vars independently', () => {
    const result = substituteEnvVars(
      {
        A: '${ROOMOTE_API_HOST}',
        B: '$POSTGRES_URL',
        C: 'literal',
      },
      lookup,
    );
    expect(result.A).toBe('https://api.example.com');
    expect(result.B).toBe('postgres://localhost:5432/db');
    expect(result.C).toBe('literal');
  });

  it('should handle $ at end of string without identifier', () => {
    const result = substituteEnvVars({ VAL: 'price$' }, lookup);
    expect(result.VAL).toBe('price$');
  });

  it('should handle ${ without closing brace', () => {
    const result = substituteEnvVars({ VAL: '${UNCLOSED' }, lookup);
    expect(result.VAL).toBe('${UNCLOSED');
  });

  it('should not match $1 or $@ (non-identifier starts)', () => {
    const result = substituteEnvVars({ VAL: '$1 and $@ and $!' }, lookup);
    expect(result.VAL).toBe('$1 and $@ and $!');
  });
});
