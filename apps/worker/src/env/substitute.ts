/**
 * Resolve $VAR and ${VAR} references in env var values against a lookup map.
 *
 * Supports both shell-style syntaxes:
 *   - ${VAR_NAME}  braced, preferred -- unambiguous
 *   - $VAR_NAME    bare, greedy identifier match per shell convention
 *
 * SECURITY:
 *   - Does NOT use shell evaluation, eval(), or child_process.
 *   - Does NOT expand $(command) or backtick syntax.
 *   - Single-pass replacement -- no recursive expansion.
 *   - Lookup is explicitly provided, never reads process.env.
 *   - Unresolved references are left intact for visibility.
 */
export function substituteEnvVars(
  vars: Record<string, string>,
  lookup: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(vars)) {
    result[key] = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced: string | undefined, bare: string | undefined) => {
        const varName = braced ?? bare!;
        return varName in lookup ? lookup[varName]! : match;
      },
    );
  }

  return result;
}
